# Maintaining the IAB upload fork

This branch adds approved local file uploads to ZCode's existing embedded browser. Upstream source
baseline: `3c5b227649371507ddc4eb46ac5133afe6db1cab` (3.16.2). The implementation and regression
contract are in [the upload spec](2026-10-22-iab-file-upload-spec.md).

## Local Windows build identity

Use the [isolated Windows build instructions](iab-file-upload-windows-build.md), with:

```powershell
$env:ZCODE_ENV = "production"
$env:ZCODE_PREVIEW_IDENTITY = "1"
$env:ZCODE_AUTO_UPDATE = "0"
```

These existing build switches produce a separate Preview identity with the official auto-updater
disabled at build time. They do not change the user's installed application or settings.
Keep the build/test home, Electron userData and sessionData separate, as described in the build guide.
Build-time values must be supplied when compiling the desktop bundles, not only when packaging.

For an isolated local launch, set `ZCODE_DESKTOP_SKIP_OS_INTEGRATION=1` in the launcher's process
environment. This optional Desktop runtime flag skips registration of the `zcode://` handler and
Finder/Explorer open-folder integration, at startup and on locale changes, so a test/fork build does
not take over the installed application's OS entrypoints. The default is unchanged (registration
runs); only the exact value `1` opts out. It does not
change callback validation, providers, credentials or application permission rules. This is a launch
setting, not a persistent user preference, and the app must be rebuilt once to include its guard.
Use `scripts/start-iab-preview.cmd` beside an `artifacts/win-unpacked` directory for the Windows fork
layout. It creates a marked, isolated profile and refuses to reuse an existing unmarked directory.

The public upstream Computer Use package is an unavailable-by-design placeholder. A source build
therefore does not reproduce the proprietary Computer Use implementation from an installed official
distribution. This fork does not replace it or modify other plugins/providers to imitate it. IAB
Browser Use is the tested upload surface. Do not replace an existing installation during build tests.

## Source updates

Keep the upload fix on its feature branch and preserve the upstream baseline/history. For a normal
clone of this fork, add `zai-org/ZCode` as an `upstream` remote, fetch it, then merge or rebase only after
inspecting the new browser code and local work. Resolve conflicts in the chooser lifecycle, ownership
checks, permissions, shared command schema, client manifest and browser guidance together.

Before using a new build, run the focused manager/chooser and SDK/manifest regressions, type/lint
checks, and the real Electron local-upload fixture. Check that the bundled Browser Use runtime and
skill came from the current source. A filename alone is not acceptance; require exact server bytes
and preserved session/tab/form state. Publish only tested custom artifacts, with their source commit
and known limitations. Never point the fork at the official update feed unless the official release
has been verified to contain equivalent upload support.

## Returning to upstream

If upstream supplies equivalent support, test it against the same regression fixture before dropping
the local patch. Merge/PR acceptance and availability in a released installer are separate milestones.
Directory and out-of-process iframe pickers remain unsupported by the current patch.
