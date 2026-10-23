import { BrowserWindow, dialog } from "electron";
import type { ApproveUpload } from "./contract.js";

// 文件路径不是权限凭据；网站不能因 agent 传入路径而直接读取桌面文件。
export const approveIabUpload: ApproveUpload = async ({ windowId, documentUrl, files, signal }) => {
  const window = BrowserWindow.fromId(windowId);
  if (!window || window.isDestroyed() || signal.aborted) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Approve local file upload",
    message: "Allow this page to receive these local files?",
    detail: `${documentUrl}\n\n${files.join("\n")}`,
    buttons: ["Cancel", "Upload files"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  });
  return response === 1 && !signal.aborted && !window.isDestroyed();
};
