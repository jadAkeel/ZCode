import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApproveUpload } from "./contract.js";
import { approveIabUpload, createIabFileChooser } from "./module.js";
import { BrowserWindow, dialog } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: { fromId: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(approve: ApproveUpload = async () => true) {
  const root = await mkdtemp(join(tmpdir(), "iab-upload-unit-"));
  roots.push(root);
  const path = join(root, "synthetic cv.pdf");
  await writeFile(path, "%PDF-1.4\nsynthetic\n%%EOF\n");
  const send = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (
      method === "Runtime.callFunctionOn" &&
      (_params as { functionDeclaration?: string })?.functionDeclaration?.includes(
        "this.value = ''",
      )
    )
      return { result: { value: true } };
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "frame", url: "http://127.0.0.1/upload" } } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn")
      return {
        result: { value: { valid: true, url: "http://127.0.0.1/upload", multiple: false } },
      };
    return {};
  });
  const chooser = createIabFileChooser({
    send,
    approve,
    assertCurrent: () => {},
    windowId: 1,
    changed: () => {},
  });
  const signal = new AbortController().signal;
  const open = async (multiple = false) => {
    const waiting = chooser.wait(1000, signal);
    await chooser.ready();
    chooser.opened({
      backendNodeId: 42,
      frameId: "frame",
      mode: multiple ? "selectMultiple" : "selectSingle",
    });
    return await waiting;
  };
  return { chooser, path, root, send, signal, open };
}

describe("IAB upload contract", () => {
  it("never interprets an OOPIF backend node ID in the root target", async () => {
    const f = await fixture();
    const waiting = f.chooser.wait(1000, f.signal);
    await f.chooser.ready();
    f.chooser.opened(
      { backendNodeId: 42, frameId: "frame", mode: "selectSingle" },
      "child-target-session",
    );
    await expect(waiting).rejects.toMatchObject({ code: "capability_unsupported" });
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    f.chooser.dispose();
  });
  it("native approval defaults to cancel, is window-bound and receives abort signal", async () => {
    const request = {
      windowId: 17,
      documentUrl: "https://upload.example/form",
      files: ["C:\\synthetic.pdf"],
      signal: new AbortController().signal,
    };
    vi.mocked(BrowserWindow.fromId).mockReturnValue(null);
    expect(await approveIabUpload(request)).toBe(false);
    const window = { isDestroyed: () => false } as BrowserWindow;
    vi.mocked(BrowserWindow.fromId).mockReturnValue(window);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await approveIabUpload(request)).toBe(false);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await approveIabUpload(request)).toBe(true);
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({
        signal: request.signal,
        cancelId: 0,
        defaultId: 0,
        detail: "https://upload.example/form\n\nC:\\synthetic.pdf",
      }),
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(await approveIabUpload({ ...request, signal: aborted.signal })).toBe(false);
  });
  it("assigns only after approval, consumes IDs and disables interception", async () => {
    const approve = vi.fn(async () => true);
    const f = await fixture(approve);
    const event = await f.open();
    expect(event.isMultiple).toBe(false);
    await f.chooser.setFiles(event.id, [f.path], 1000, f.signal);
    expect(approve).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      backendNodeId: 42,
      files: [f.path],
    });
    expect(f.send).toHaveBeenCalledWith("Page.setInterceptFileChooserDialog", { enabled: false });
    await expect(f.chooser.setFiles(event.id, [f.path], 1000, f.signal)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    f.chooser.dispose();
  });

  it("rejects invalid paths and directories before approval and permits correction", async () => {
    const approve = vi.fn(async () => true);
    const f = await fixture(approve);
    const event = await f.open();
    for (const path of [
      "relative.pdf",
      join(f.root, "missing.pdf"),
      f.root,
      "\\\\server\\share\\cv.pdf",
      "\\\\.\\NUL",
    ]) {
      await expect(f.chooser.setFiles(event.id, [path], 1000, f.signal)).rejects.toMatchObject({
        code: "execution_error",
      });
    }
    expect(approve).not.toHaveBeenCalled();
    await f.chooser.setFiles(event.id, [f.path], 1000, f.signal);
    f.chooser.dispose();
  });

  it("rejects multiple files on a single picker without partial assignment", async () => {
    const f = await fixture();
    const event = await f.open();
    await expect(
      f.chooser.setFiles(event.id, [f.path, f.path], 1000, f.signal),
    ).rejects.toMatchObject({ code: "execution_error" });
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    await f.chooser.setFiles(event.id, [], 1000, f.signal);
    expect(f.send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "node",
        functionDeclaration: expect.stringContaining("this.value = ''"),
      }),
    );
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    f.chooser.dispose();
  });

  it("supports multiple files, validates every path before assignment", async () => {
    const f = await fixture();
    const event = await f.open(true);
    expect(event.isMultiple).toBe(true);
    f.send.mockImplementation(async (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", url: "http://127.0.0.1/upload" } } };
      if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
      if (method === "Runtime.callFunctionOn")
        return {
          result: { value: { valid: true, url: "http://127.0.0.1/upload", multiple: true } },
        };
      return {};
    });
    await expect(
      f.chooser.setFiles(event.id, [f.path, join(f.root, "missing")], 1000, f.signal),
    ).rejects.toMatchObject({ code: "execution_error" });
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    await f.chooser.setFiles(event.id, [f.path, f.path], 1000, f.signal);
    f.chooser.dispose();
  });

  it("denies files without approval and invalidates the chooser", async () => {
    const f = await fixture(async () => false);
    const event = await f.open();
    await expect(f.chooser.setFiles(event.id, [f.path], 1000, f.signal)).rejects.toMatchObject({
      code: "cancelled",
      sideEffect: "none",
    });
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    expect(f.chooser.active).toBe(false);
    f.chooser.dispose();
  });

  it("rejects a file changed during approval", async () => {
    let path = "";
    const f = await fixture(async () => {
      await writeFile(path, "changed contents");
      return true;
    });
    path = f.path;
    const event = await f.open();
    await expect(f.chooser.setFiles(event.id, [path], 1000, f.signal)).rejects.toThrow(
      "changed while awaiting approval",
    );
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    f.chooser.dispose();
  });

  it("cancels during approval and rejects late approval without assigning", async () => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const enteredApproval = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(() => {
      entered();
      return new Promise((resolve) => {
        approve = resolve;
      });
    });
    const event = await f.open();
    const controller = new AbortController();
    const setting = f.chooser.setFiles(event.id, [f.path], 1000, controller.signal);
    await enteredApproval;
    controller.abort();
    await expect(setting).rejects.toMatchObject({ code: "cancelled", sideEffect: "none" });
    approve(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    f.chooser.dispose();
  });

  it("times out without an event, restores native picker and can wait again", async () => {
    const f = await fixture();
    await expect(f.chooser.wait(10, f.signal)).rejects.toMatchObject({ code: "timeout" });
    await f.chooser.ready();
    expect(f.send).toHaveBeenLastCalledWith("Page.setInterceptFileChooserDialog", {
      enabled: false,
    });
    f.chooser.opened({ backendNodeId: 999, mode: "selectSingle" });
    const event = await f.open();
    await f.chooser.setFiles(event.id, [], 1000, f.signal);
    f.chooser.dispose();
  });

  it("times out during approval and cannot assign after a late approval", async () => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(() => {
      entered();
      return new Promise((resolve) => {
        approve = resolve;
      });
    });
    const event = await f.open();
    const setting = f.chooser.setFiles(event.id, [f.path], 50, f.signal);
    await started;
    await expect(setting).rejects.toMatchObject({ code: "timeout", sideEffect: "none" });
    approve(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.send.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
    expect(f.chooser.active).toBe(false);
    f.chooser.dispose();
  });

  it("rejects parallel waits and disposal cancels a pending wait", async () => {
    const f = await fixture();
    const waiting = f.chooser.wait(1000, f.signal);
    await f.chooser.ready();
    await expect(f.chooser.wait(1000, f.signal)).rejects.toMatchObject({ code: "execution_error" });
    f.chooser.dispose();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects stale IDs after disposal or expiry", async () => {
    const f = await fixture();
    const event = await f.open();
    vi.useFakeTimers();
    // Timer was created before fake timers; exercise disposal here and expiry below.
    f.chooser.dispose();
    await expect(f.chooser.setFiles(event.id, [f.path], 1000, f.signal)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    vi.useRealTimers();
    const g = await fixture();
    vi.useFakeTimers();
    const expired = await g.open();
    await vi.advanceTimersByTimeAsync(120_001);
    await expect(g.chooser.setFiles(expired.id, [], 1000, g.signal)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    g.chooser.dispose();
  });
});
