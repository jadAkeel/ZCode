import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FileChooserOptions, IabFileChooser } from "./contract.js";
import { UploadError } from "./contract.js";
export { approveIabUpload } from "./nativeApproval.js";

const CHOOSER_TTL_MS = 120_000;
interface Chooser {
  id: string;
  backendNodeId: number;
  frameId: string;
  multiple: boolean;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function createIabFileChooser(options: FileChooserOptions): IabFileChooser {
  return new GuestFileChooser(options);
}

class GuestFileChooser implements IabFileChooser {
  private disposed = false;
  private chooser?: Chooser;
  private waiter?: {
    resolve(value: { id: string; isMultiple: boolean }): void;
    reject(error: unknown): void;
  };
  private arming: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();

  constructor(private readonly options: FileChooserOptions) {}

  get active(): boolean {
    return Boolean(this.waiter || this.chooser);
  }

  ready(): Promise<void> {
    return this.arming;
  }

  async wait(timeoutMs: number, signal: AbortSignal): Promise<{ id: string; isMultiple: boolean }> {
    this.assertLive(signal);
    if (this.active)
      throw new UploadError("execution_error", "A file chooser is already active for this tab");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, deadline, this.lifetime.signal]);
    let waiter!: NonNullable<GuestFileChooser["waiter"]>;
    const event = new Promise<{ id: string; isMultiple: boolean }>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiter = waiter;
    });
    // 修复原因：先注册 waiter 再启用拦截；click 必须等待同一 arm barrier，避免原生选择器抢先打开。
    this.arming = this.arming.then(async () => {
      this.assertLive(combined);
      await this.options.send("Page.setInterceptFileChooserDialog", { enabled: true });
    });
    this.options.changed();
    let delivered = false;
    try {
      const value = await bounded(async () => {
        await this.arming;
        return await event;
      }, combined);
      delivered = true;
      return value;
    } finally {
      if (this.waiter === waiter) this.waiter = undefined;
      if (!delivered && this.chooser) this.clearChooser(this.chooser);
      // 消费或超时后立刻恢复用户原生 picker；迟到事件不能生成可复用的句柄。
      this.arming = this.arming
        .catch(() => undefined)
        .then(async () => {
          if (!this.disposed)
            await this.options.send("Page.setInterceptFileChooserDialog", { enabled: false });
        });
      void this.arming.catch(() => undefined);
      this.options.changed();
    }
  }

  opened(params: unknown, cdpSessionId?: string): void {
    if (this.disposed || !this.waiter) return;
    // 子 target 的 backendNodeId 不能拿到 root target 上使用，防止跨 renderer 节点误指派。
    if (cdpSessionId) {
      this.waiter.reject(
        new UploadError(
          "capability_unsupported",
          "File chooser belongs to an unsupported out-of-process frame",
        ),
      );
      this.waiter = undefined;
      return;
    }
    const data = params as { backendNodeId?: number; mode?: string; frameId?: string } | null;
    if (
      !data ||
      !Number.isInteger(data.backendNodeId) ||
      !data.frameId ||
      (data.mode !== "selectSingle" && data.mode !== "selectMultiple")
    ) {
      this.waiter.reject(new UploadError("execution_error", "Unsupported file chooser event"));
      this.waiter = undefined;
      return;
    }
    const chooser: Chooser = {
      id: randomUUID(),
      backendNodeId: data.backendNodeId!,
      frameId: data.frameId,
      multiple: data.mode === "selectMultiple",
      busy: false,
      timer: setTimeout(() => this.clearChooser(chooser), CHOOSER_TTL_MS),
    };
    chooser.timer.unref?.();
    this.chooser = chooser;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter.resolve({ id: chooser.id, isMultiple: chooser.multiple });
    this.options.changed();
  }

  async setFiles(
    id: string,
    files: string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertLive(signal);
    const chooser = this.chooser;
    if (!chooser || chooser.id !== id)
      throw new UploadError(
        "backend_unavailable",
        "File chooser is stale or unavailable for this tab",
      );
    if (chooser.busy)
      throw new UploadError("execution_error", "File chooser assignment is already running");
    if (!Array.isArray(files) || files.length > 100 || (!chooser.multiple && files.length > 1)) {
      throw new UploadError("execution_error", "Invalid file count for this file chooser");
    }
    chooser.busy = true;
    let dispatched = false;
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs),
      this.lifetime.signal,
    ]);
    const assertCurrent = () => {
      this.assertLive(combined);
      if (this.chooser !== chooser)
        throw new UploadError("backend_unavailable", "File chooser expired or changed");
    };
    try {
      await bounded(async () => {
        await this.ready();
        const approvedFiles = await validateFiles(files);
        assertCurrent();
        const node = await this.inspectNode(chooser);
        assertCurrent();
        if (
          files.length &&
          !(await this.options.approve({
            windowId: this.options.windowId,
            documentUrl: node.url,
            files: approvedFiles.map((file) => file.path),
            signal: combined,
          }))
        ) {
          this.clearChooser(chooser);
          throw new UploadError("cancelled", "Local file upload approval was cancelled");
        }
        assertCurrent();
        // 授权可能等待很久；授权后重新验证 canonical path、文件身份与页面节点，不能沿用旧检查结果。
        const checked = await validateFiles(files);
        if (JSON.stringify(approvedFiles) !== JSON.stringify(checked))
          throw new UploadError("execution_error", "Upload file changed while awaiting approval");
        const currentNode = await this.inspectNode(chooser);
        if (JSON.stringify(currentNode) !== JSON.stringify(node))
          throw new UploadError(
            "backend_unavailable",
            "File input changed while awaiting approval",
          );
        assertCurrent();
        this.clearChooser(chooser);
        dispatched = true;
        if (checked.length === 0) {
          await this.clearInput(chooser, combined);
        } else {
          await this.options.send("DOM.setFileInputFiles", {
            backendNodeId: chooser.backendNodeId,
            files: checked.map((file) => file.path),
          });
        }
        this.assertLive(combined);
      }, combined);
    } catch (error) {
      if (combined.aborted || dispatched) this.clearChooser(chooser);
      if (dispatched)
        throw new UploadError(
          combined.aborted ? abortError(combined).code : "execution_error",
          error instanceof Error ? error.message : String(error),
          "uncertain",
        );
      throw error;
    } finally {
      chooser.busy = false;
    }
  }

  private async clearInput(chooser: Chooser, signal: AbortSignal): Promise<void> {
    const resolved = (await this.options.send("DOM.resolveNode", {
      backendNodeId: chooser.backendNodeId,
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId)
      throw new UploadError("backend_unavailable", "File input is no longer available");
    try {
      this.assertLive(signal);
      // 实测 Electron 的 DOM.setFileInputFiles([]) 只取消 picker，旧 FileList 不清空。
      // 空选择用原节点的合法 value='' 清空，并通知网页；非空文件仍只能由 CDP 写入。
      const result = (await this.options.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() { if (!this.isConnected || this.tagName !== 'INPUT' || this.type !== 'file') return false; this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true, composed: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.files.length === 0; }`,
        returnByValue: true,
      })) as { result?: { value?: boolean } };
      if (result.result?.value !== true)
        throw new UploadError("execution_error", "Unable to clear file input");
    } finally {
      await this.options.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private async inspectNode(chooser: Chooser): Promise<{ url: string; multiple: boolean }> {
    // URL 来自 Chromium frame tree，不信任网页可覆盖的 DOM getter 来决定授权目的地。
    interface FrameTree {
      frame: { id: string; url: string };
      childFrames?: FrameTree[];
    }
    const tree = (await this.options.send("Page.getFrameTree")) as { frameTree?: FrameTree };
    const findFrame = (entry: FrameTree | undefined): string | undefined => {
      if (!entry) return undefined;
      if (entry.frame.id === chooser.frameId) return entry.frame.url;
      return entry.childFrames?.map(findFrame).find(Boolean);
    };
    const url = findFrame(tree.frameTree);
    if (!url || !/^https?:\/\//i.test(url))
      throw new UploadError(
        "backend_unavailable",
        "File chooser frame is unavailable or unsupported",
      );
    const resolved = (await this.options.send("DOM.resolveNode", {
      backendNodeId: chooser.backendNodeId,
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId)
      throw new UploadError("backend_unavailable", "File input is no longer available");
    try {
      const result = (await this.options.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() { return { valid: this.isConnected && this.tagName === 'INPUT' && this.type === 'file' && !this.webkitdirectory, url: this.ownerDocument.URL, multiple: this.multiple }; }`,
        returnByValue: true,
      })) as { result?: { value?: { valid?: boolean; url?: string; multiple?: boolean } } };
      const node = result.result?.value;
      if (
        !node?.valid ||
        typeof node.url !== "string" ||
        node.multiple !== chooser.multiple ||
        !/^https?:\/\//i.test(node.url)
      ) {
        throw new UploadError(
          "backend_unavailable",
          "File input is detached, changed, or unsupported",
        );
      }
      return { url, multiple: node.multiple };
    } finally {
      await this.options.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private assertLive(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal);
    if (this.disposed)
      throw new UploadError("backend_unavailable", "Browser file chooser was closed");
    this.options.assertCurrent();
  }

  private clearChooser(chooser: Chooser): void {
    if (this.chooser !== chooser) return;
    clearTimeout(chooser.timer);
    this.chooser = undefined;
    this.options.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new DOMException("Browser file chooser was closed", "AbortError"));
    if (this.chooser) this.clearChooser(this.chooser);
    this.waiter = undefined;
    this.arming = this.arming
      .catch(() => undefined)
      .then(async () => {
        await this.options.send("Page.setInterceptFileChooserDialog", { enabled: false });
      });
    void this.arming.catch(() => undefined);
    this.options.changed();
  }
}

async function validateFiles(files: string[]) {
  return await Promise.all(
    files.map(async (path) => {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
        /^(?:\\\\|\/\/)/.test(path) ||
        (process.platform === "win32" &&
          (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(":")))
      ) {
        throw new UploadError(
          "execution_error",
          "Upload requires absolute local file paths (no network/device paths)",
        );
      }
      try {
        const canonical = await realpath(path);
        if (/^(?:\\\\|\/\/)/.test(canonical)) throw new Error("Network paths are not supported");
        const info = await stat(canonical);
        if (!info.isFile()) throw new Error("Not a regular file");
        await access(canonical, constants.R_OK);
        return {
          path: canonical,
          dev: info.dev,
          ino: info.ino,
          size: info.size,
          mtime: info.mtimeMs,
          ctime: info.ctimeMs,
        };
      } catch (error) {
        throw new UploadError(
          "execution_error",
          `Invalid upload file: ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

function abortError(signal: AbortSignal): UploadError {
  return signal.reason?.name === "TimeoutError"
    ? new UploadError("timeout", "File chooser operation timed out")
    : new UploadError("cancelled", "File chooser operation cancelled");
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
