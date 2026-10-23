# Windows: IAB upload verification and build

Use PowerShell in the dedicated source checkout. The source baseline for this patch is
`3c5b227649371507ddc4eb46ac5133afe6db1cab` (3.16.2). The inspected installed executable was
3.15.3.8237, with Electron 41.0.3. The patch is not installed in that executable.

## Toolchain and dependencies

Use Node **24.14.0** and pnpm **10.33.2** (`mise.toml`). The investigation machine had Node
24.11.1; the focused checks and Electron fixture are reported separately from full build readiness.

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
```

The repository normally installs optional binaries for several operating systems. On a Windows-only
development machine, `supportedArchitectures` can temporarily be reduced to `current` in
`pnpm-workspace.yaml` to reduce downloads; restore the file after installation and do not publish
that local-only change. Do not change the lockfile, provider configuration or existing user data.
An interrupted install is not a successful dependency/build gate. The retained validation report
records the download and workspace-link issues encountered on the investigation machine.

## Focused tests (after a complete install)

```powershell
pnpm exec vitest run packages/desktop/src/main/browserView/fileUpload/contract.test.ts packages/desktop/test/browserGuestManager.test.ts
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/core exec vitest run tests/browser-client.test.ts tests/browser-manifest.test.ts
pnpm --filter @zcode/desktop test:browser-file-upload-smoke
pnpm typecheck
pnpm lint
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm architecture:check -- --changed
```

The CLI tests must run with `apps/zcode-cli/packages/core` as their working directory (the filter
above does this); their existing documentation fixture paths are package-relative.

The smoke test builds the actual guest manager and SDK with a minimal Electron host and an actual
`<webview>` guest. Only diagnostic disk logging is replaced with console/no-op logging, preventing
the application logger from touching an existing data directory. Browser commands, chooser events,
file assignment, page events, network requests and multipart bytes are real. Positive file approval
uses a fixture-only allowlist of the two generated synthetic files; the real native approval dialog's
AbortSignal cancellation is also exercised. This is not full Desktop/agent/provider acceptance.

## Offline Electron fixture host using installed runtime binaries

If the Electron archive cannot be downloaded, the following creates a **new** fixture runtime from
the installed application binaries. It copies no `app.asar`, settings, profiles, chats, credentials or
application data. It does not launch, modify or close the installed executable. Choose a new output
directory; the preparation script refuses an existing directory or one overlapping the installation.

```powershell
$fixtureRuntime = Join-Path $env:TEMP ("zcode-iab-fixture-" + [guid]::NewGuid().ToString("N"))
node packages/desktop/scripts/prepare-iab-upload-fixture-runtime.mjs "--source=$env:LOCALAPPDATA\Programs\ZCode" "--out=$fixtureRuntime"
node packages/desktop/scripts/run-iab-upload-smoke.mjs "--fixture-runtime=$fixtureRuntime"
```

Each run creates a separate temporary data root and prints its location. `result.json` contains
server-received filenames, byte counts, SHA-256 hashes, runtime version and passed checks. On an
assertion failure, inspect `error.txt` in that root. A successful run must exit 0 and report exact
server-byte equality, not merely a selected filename. The fixture closes only its own test guest
and host. Its temporary synthetic files/profile remain available for inspection.

## Full desktop development and Windows installer

These are the source repository's full build routes. Complete the dependency step and full type/lint
gates first. Required downloads include Electron/runtime assets and packaging tools. A fixture pass
and a successful full desktop/package build are separate checks; record the outcome of each.

```powershell
# Isolate development storage before invoking app/runtime build or launch commands.
$devRoot = Join-Path $PWD ".iab-development-home"
New-Item -ItemType Directory -Force -Path $devRoot | Out-Null
$env:HOME = $devRoot
$env:USERPROFILE = $devRoot
$env:ZCODE_HOME = Join-Path $devRoot ".zcode"
$env:ZCODE_DATA_BASE_DIR = $devRoot
$env:ZCODE_DESKTOP_HOME_DIR = $devRoot
$env:ZCODE_DESKTOP_APPLICATION_NAME = "ZCode Upload Development"
$env:ZCODE_DESKTOP_SKIP_OS_INTEGRATION = "1"
$env:ZCODE_DESKTOP_USER_DATA_DIR = Join-Path $devRoot "electron"
$env:ZCODE_DESKTOP_SESSION_DATA_DIR = Join-Path $devRoot "electron-session"
$env:ZCODE_PREVIEW_IDENTITY = "1"
$env:ZCODE_AUTO_UPDATE = "0"
pnpm bootstrap
pnpm dev:desktop:test
```

For a Windows x64 preview installer, in the same isolated shell after the preceding setup/build:

```powershell
pnpm bundle:desktop -- --os win --arch x64
```

Artifacts are under `packages/desktop/dist` unless `ZCODE_DESKTOP_DIST_DIR` is explicitly set. Do not
run an installer over the existing installation as part of this verification. Any future installation
and test with a real logged-in user tab is a separate step; keep a distinct installation location and
data root, and obtain explicit authorization before replacing the installed application. This patch
does not migrate or copy existing browser sessions into a development instance.

`HOME`/`USERPROFILE` isolation is intentional: the existing early bootstrap reads a settings file
under `os.homedir()` before normal app startup and may otherwise apply a saved data-directory
override. Setting only `ZCODE_DATA_BASE_DIR` is not a sufficient fresh-user isolation guarantee.
