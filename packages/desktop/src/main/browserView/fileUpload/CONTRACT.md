# Desktop IAB file chooser

Main-process adapter for the existing owned guest CDP connection. `createIabFileChooser` owns only
ephemeral waiters and single-use chooser IDs. `assertCurrent` enforces the existing full tab scope
and guest generation before every dispatch. `approve` is a one-time desktop-local file grant;
production uses `approveIabUpload`, and local fixtures approve only their own synthetic files.

See `docs/browser-use/2026-10-22-iab-file-upload-spec.md` for lifecycle, event order and acceptance.
No persistence, profile access, external browser launch, provider configuration or model inference.
