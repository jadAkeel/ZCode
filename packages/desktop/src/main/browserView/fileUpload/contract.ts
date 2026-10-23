export interface UploadApproval {
  windowId: number;
  documentUrl: string;
  files: readonly string[];
  signal: AbortSignal;
}

export type ApproveUpload = (request: UploadApproval) => Promise<boolean>;

export interface FileChooserOptions {
  send(method: string, params?: unknown): Promise<unknown>;
  assertCurrent(): void;
  approve: ApproveUpload;
  windowId: number;
  changed(): void;
}

export interface IabFileChooser {
  readonly active: boolean;
  ready(): Promise<void>;
  wait(timeoutMs: number, signal: AbortSignal): Promise<{ id: string; isMultiple: boolean }>;
  setFiles(id: string, files: string[], timeoutMs: number, signal: AbortSignal): Promise<void>;
  opened(params: unknown, cdpSessionId?: string): void;
  dispose(): void;
}

export class UploadError extends Error {
  constructor(
    readonly code:
      | "execution_error"
      | "timeout"
      | "cancelled"
      | "backend_unavailable"
      | "capability_unsupported",
    message: string,
    readonly sideEffect: "none" | "uncertain" = "none",
  ) {
    super(message);
  }
}
