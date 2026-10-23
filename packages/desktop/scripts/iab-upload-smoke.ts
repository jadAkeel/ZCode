import { app, BrowserWindow, webContents } from "electron";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserGuestManager } from "../src/main/browserView/browserGuestManager.js";
import { approveIabUpload } from "../src/main/browserView/fileUpload/module.js";
import { PlaywrightAPI } from "../../../apps/zcode-cli/packages/core/src/browser-client/playwright.js";
import { browserCommandSchema } from "@zcode/shared";
import type { BrowserCommand } from "@zcode/shared";

const root = process.argv
  .find((arg) => arg.startsWith("--upload-smoke-root="))
  ?.split("=")
  .slice(1)
  .join("=");
if (!root) throw new Error("An isolated fixture root is required");
app.setName("ZCode IAB Upload Verification");
app.setPath("userData", join(root, "profile"));
app.setPath("sessionData", join(root, "profile"));
app.setPath("crashDumps", root);
app.setAppLogsPath(root);
const deadline = setTimeout(() => app.exit(1), 110_000);
let host: BrowserWindow | undefined;
let manager: BrowserGuestManager | undefined;
const receipts: Array<{ name: string; bytes: Buffer; cookie: string; note: string }> = [];
let origin = "";
function syntheticPdf(): Buffer {
  let source = "%PDF-1.4\n";
  const text = "BT /F1 12 Tf 20 100 Td (Synthetic CV upload fixture only) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(source);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
const pdf = syntheticPdf();
const secondPdf = Buffer.concat([pdf, Buffer.from([0, 1, 2, 128, 255])]);
const path = join(root, "Synthetic CV.pdf");
const secondPath = join(root, "Synthetic second.pdf");
const html = `<!doctype html><html><title>IAB upload fixture</title><body>
<form id="form"><label>Applicant note<input name="note" id="note" value="prefilled draft"></label>
<input type="file" id="cv" name="cv" accept="application/pdf">
<button type="button" id="pick" onclick="document.querySelector('#cv').click()">Upload CV</button>
<button type="submit" id="send">Send to local fixture</button></form><output id="status"></output>
<script>localStorage.setItem('login','fixture-user');sessionStorage.setItem('draft','keep-me');
form.addEventListener('submit',async event=>{event.preventDefault(); const response=await fetch('/upload',{method:'POST',body:new FormData(form)});document.querySelector('#status').textContent=JSON.stringify(await response.json());document.body.dataset.received='yes';});</script>
</body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/fixture") {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "fixture_login=synthetic-session; HttpOnly; SameSite=Strict; Path=/",
      });
      response.end(html);
      return;
    }
    if (request.method === "POST" && request.url === "/upload") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const boundary = /boundary=(.+)$/.exec(request.headers["content-type"] ?? "")?.[1];
      assert.ok(boundary, "multipart boundary missing");
      const marker = Buffer.from(`--${boundary}`);
      let index = 0;
      let note = "";
      const files: Array<{ name: string; bytes: Buffer }> = [];
      while ((index = body.indexOf(marker, index)) >= 0) {
        index += marker.length;
        if (body.subarray(index, index + 2).toString() === "--") break;
        const headerEnd = body.indexOf("\r\n\r\n", index);
        const next = body.indexOf(marker, headerEnd + 4);
        assert.ok(headerEnd >= 0 && next >= 0);
        const headers = body.subarray(index, headerEnd).toString();
        const value = body.subarray(headerEnd + 4, next - 2);
        const filename = /filename="([^"]*)"/.exec(headers)?.[1];
        if (filename) files.push({ name: filename, bytes: Buffer.from(value) });
        else if (headers.includes('name="note"')) note = value.toString();
        index = next;
      }
      assert.match(request.headers.cookie ?? "", /fixture_login=synthetic-session/);
      assert.equal(note, "unsaved note retained");
      for (const file of files) receipts.push({ ...file, cookie: request.headers.cookie!, note });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          accepted: files.map((file) => ({ name: file.name, size: file.bytes.length })),
        }),
      );
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

async function run() {
  await writeFile(path, pdf);
  await writeFile(secondPath, secondPdf);
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  host = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, backgroundThrottling: false },
  });
  const hostHtml = `<!doctype html><webview id="guest" src="${origin}/fixture"></webview><script>window.ready=new Promise(resolve=>guest.addEventListener('dom-ready',()=>resolve(guest.getWebContentsId()),{once:true}));</script>`;
  await host.loadURL(`data:text/html;base64,${Buffer.from(hostHtml).toString("base64")}`);
  const guestId = (await host.webContents.executeJavaScript("window.ready")) as number;
  const guest = webContents.fromId(guestId);
  assert.ok(guest);
  assert.equal(guest.getType(), "webview");
  let approvalMode: "allow" | "deny" | "wait" = "allow";
  let approvalEntered: (() => void) | undefined;
  let resolveApproval: ((allow: boolean) => void) | undefined;
  let approvalCalls = 0;
  manager = new BrowserGuestManager(
    undefined,
    10_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      approveUpload: async (request) => {
        approvalCalls++;
        assert.equal(request.windowId, host!.id);
        assert.equal(request.documentUrl, `${origin}/fixture`);
        assert.ok(
          request.files.every((file) => [path, secondPath].includes(file)),
          "fixture may approve only synthetic files",
        );
        if (approvalMode === "wait") {
          approvalEntered?.();
          return await new Promise((resolve) => {
            resolveApproval = resolve;
          });
        }
        return approvalMode === "allow";
      },
    },
  );
  const context = {
    requestId: "initial",
    browserId: "iab",
    browserGeneration: 1,
    windowId: host.id,
    workspaceKey: root!,
    sessionId: "synthetic-session",
    turnId: "upload-turn",
    clientMode: "desktop-continuous" as const,
  };
  const tabId = "existing-fixture-tab";
  assert.equal(
    manager.attachGuest(tabId, guestId, {
      windowId: host.id,
      workspaceKey: root,
      sessionId: context.sessionId,
    }).ok,
    true,
  );
  assert.equal(
    (await manager.execute({ ...context, requestId: randomUUID() }, { method: "claimTab", tabId }))
      .ok,
    true,
  );
  const execute = (command: BrowserCommand, signal?: AbortSignal) =>
    manager!.execute(
      { ...context, requestId: randomUUID() },
      browserCommandSchema.parse({ ...command, tabId }),
      signal,
    );
  const api = new PlaywrightAPI(execute);
  await guest.executeJavaScript("document.querySelector('#note').value = 'unsaved note retained'");
  const state = async () => ({
    guestId: guest.id,
    url: guest.getURL(),
    ...((await guest.executeJavaScript(
      `({ note: document.querySelector('#note').value, local: localStorage.getItem('login'), session: sessionStorage.getItem('draft') })`,
    )) as object),
    cookies: (await guest.session.cookies.get({ url: origin })).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
    })),
    tabs: (
      await manager!.execute({ ...context, requestId: randomUUID() }, { method: "list" })
    ).tabs?.map((tab) => tab.tabId),
  });
  const before = await state();
  const openPicker = async () => {
    const [chooser] = await Promise.all([
      api.waitForEvent("filechooser", { timeoutMs: 5000 }),
      api.locator("#pick").click(),
    ]);
    return chooser;
  };
  const submit = async () => {
    await guest.executeJavaScript("delete document.body.dataset.received");
    await api.locator("#send").click();
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      !(await guest.executeJavaScript("document.body.dataset.received === 'yes'"))
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await guest.executeJavaScript("document.body.dataset.received"), "yes");
  };

  // Actual existing guest, agent-facing API, exact server receipt (not selected filename).
  const chooser = await openPicker();
  assert.equal(chooser.isMultiple(), false);
  await assert.rejects(chooser.setFiles([path, secondPath]), /file count/);
  await assert.rejects(chooser.setFiles(join(root!, "missing.pdf")), /Invalid upload file/);
  assert.equal(approvalCalls, 0);
  await chooser.setFiles(path);
  await submit();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].name, "Synthetic CV.pdf");
  assert.deepEqual(receipts[0].bytes, await readFile(path));
  assert.deepEqual(await state(), before);
  await assert.rejects(chooser.setFiles(path), /stale or unavailable/);

  const cancel = await openPicker();
  await cancel.setFiles([]);
  assert.equal(await guest.executeJavaScript("document.querySelector('#cv').files.length"), 0);
  assert.equal(receipts.length, 1);
  approvalMode = "deny";
  await assert.rejects((await openPicker()).setFiles(path), /approval was cancelled/);
  assert.equal(await guest.executeJavaScript("document.querySelector('#cv').files.length"), 0);
  approvalMode = "allow";

  // Same tab, multiple files; binary suffix verifies byte-safe server parsing.
  await guest.executeJavaScript("document.querySelector('#cv').multiple = true");
  const multiple = await openPicker();
  assert.equal(multiple.isMultiple(), true);
  await multiple.setFiles([path, secondPath]);
  await submit();
  assert.deepEqual(
    receipts.slice(1).map((receipt) => receipt.name),
    ["Synthetic CV.pdf", "Synthetic second.pdf"],
  );
  assert.deepEqual(receipts[1].bytes, pdf);
  assert.deepEqual(receipts[2].bytes, secondPdf);
  assert.deepEqual(await state(), before);

  await assert.rejects(api.waitForEvent("filechooser", { timeoutMs: 50 }), /timed out/);
  const abortWait = new AbortController();
  const waiting = execute(
    {
      method: "playwright",
      action: { name: "waitForEvent", event: "filechooser", timeoutMs: 5000 },
    },
    abortWait.signal,
  );
  abortWait.abort();
  assert.equal((await waiting).error?.code, "cancelled");

  approvalMode = "wait";
  const entered = new Promise<void>((resolve) => {
    approvalEntered = resolve;
  });
  const pendingChooser = await openPicker();
  const selectedBeforeCancellation = await guest.executeJavaScript(
    "Array.from(document.querySelector('#cv').files, file => file.name)",
  );
  const pending = pendingChooser.setFiles(path);
  await entered;
  manager.endTurn(context, context.turnId);
  await assert.rejects(pending, /cancelled/);
  resolveApproval?.(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    await guest.executeJavaScript(
      "Array.from(document.querySelector('#cv').files, file => file.name)",
    ),
    selectedBeforeCancellation,
  );
  assert.equal(
    (await manager.execute({ ...context, requestId: randomUUID() }, { method: "claimTab", tabId }))
      .ok,
    true,
  );
  assert.deepEqual(await state(), before);
  assert.equal(receipts.length, 3);

  // Exercise the real Windows/Electron native permission dialog cancellation, not a stub.
  const cancelNative = new AbortController();
  const cancelTimer = setTimeout(() => cancelNative.abort(), 500);
  try {
    assert.equal(
      await approveIabUpload({
        windowId: host.id,
        documentUrl: `${origin}/fixture`,
        files: [path],
        signal: cancelNative.signal,
      }),
      false,
    );
  } finally {
    clearTimeout(cancelTimer);
  }

  approvalMode = "allow";
  const beforeNavigation = await openPicker();
  await guest.loadURL(`${origin}/fixture`);
  await assert.rejects(beforeNavigation.setFiles(path), /stale or unavailable/);
  const closing = execute({
    method: "playwright",
    action: { name: "waitForEvent", event: "filechooser", timeoutMs: 5000 },
  });
  await api.locator("#note").count(); // same-guest arm barrier
  assert.equal((await execute({ method: "close" })).ok, true);
  assert.equal((await closing).error?.code, "cancelled");

  const report = {
    status: "passed",
    electron: process.versions.electron,
    guestType: "webview",
    guestId,
    tabId,
    sessionAndFormPreserved: true,
    receipts: receipts.map(({ name, bytes }) => ({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
    checks: [
      "exact server bytes",
      "cookie login",
      "local/session storage",
      "unsaved form",
      "same URL/tab/guest",
      "invalid path",
      "single/multiple",
      "empty cancellation",
      "approval denial",
      "replayed chooser",
      "timeout",
      "abort wait",
      "turn end during approval: no late assignment",
      "real native approval dialog cancellation",
      "navigation invalidates chooser",
      "tab closure cancels waiter",
    ],
  };
  await writeFile(join(root!, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

void run().then(
  () => finish(0),
  async (error) => {
    await writeFile(
      join(root!, "error.txt"),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    console.error(error);
    finish(1);
  },
);
function finish(code: number) {
  clearTimeout(deadline);
  manager?.disposeAll();
  if (host && !host.isDestroyed()) host.destroy();
  server.close();
  app.exit(code);
}
