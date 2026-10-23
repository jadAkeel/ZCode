# IAB file uploads

Scope: approved local file uploads in the existing IAB guest, with isolated regression and Electron
loopback verification. This does not alter Computer Use, providers or existing browser profiles.

## Contract and ownership

Keep `tab.playwright.waitForEvent("filechooser")`, `isMultiple()` and `setFiles(paths, { timeoutMs })`.
`setFiles([])` cancels/clears a chooser without granting access to files. Paths must be absolute,
readable regular local files; directories, device/network paths and missing files fail before assignment.
The desktop asks for one-time approval of the canonical files and destination document URL. Approval
is not a permanent directory grant and does not bypass the existing browser/session permission gates.
The default without an approval provider is deny. Remote agents may only select desktop-local files
after this approval; remote filesystem paths are not translated or downloaded implicitly.

The main-process guest manager remains the sole owner of tab identity. A per-guest file chooser
controller owns ephemeral waiter/chooser state. It uses that guest's existing debugger, never another
browser, target tab, profile or navigation. Chooser IDs are opaque, single-use after dispatch, and
bound to the full existing owner scope and guest generation. Invalid path/cardinality errors are
retryable with the same live chooser. Denial, cancellation, timeout, navigation, guest replacement,
tab close, owner release, turn end and session close invalidate pending IDs. Unused IDs expire after
120 seconds. One waiter and one chooser per tab are supported; concurrent waits fail explicitly.
Handles are also bound to their issuing turn; a delayed end notification for an older turn cannot
invalidate a newer turn's active chooser or release its claimed user tab.

```text
agent wait → owned tab/guest → install waiter → enable CDP interception
agent click ────────────────────────────────→ await arm barrier → existing guest click
Page.fileChooserOpened → opaque ID + mode → disable interception
setFiles → validate ID/scope → validate all files → native approval → revalidate files/node/scope
         → consume ID → DOM.setFileInputFiles(backendNodeId, exact approved paths)
         → page input/change events → website uploads through its existing session
```

For an empty list, resolve that same backend node and clear its permitted `value = ''`, then emit
input/change. Real Electron verification showed `DOM.setFileInputFiles([])` cancels the chooser but
does not clear a previous FileList; a returned success without clearing was rejected by the fixture.

Directory selection is intentionally rejected. Cross-origin out-of-process iframe (OOPIF) chooser
interception is not implemented: events carrying a child CDP session ID fail closed instead of
interpreting a child renderer's backendNodeId in the root renderer. No alternate browser is opened.
Top-level inputs are verified by the live fixture; general iframe acceptance remains a limitation.

CDP idle release and tab suspension are held while a waiter/chooser is active. Teardown still wins.
When the chooser settles or expires, normal CDP idle release resumes without replacing the guest.
Cancellation before assignment has no file side effect. Cancellation after CDP dispatch is reported
as uncertain; it must never report a guaranteed rollback. Native approval receives the cancellation
signal and a late approval cannot dispatch a cancelled operation. Upload assignment is not proof of
server receipt. The browser skill requires a site success response; the local smoke fixture compares
the received filename and exact bytes and checks cookie, storage, URL, tab/guest ID and form state.

## Acceptance

- Real Electron `<webview>` guest, synthetic PDF, loopback HTTP server, exact multipart bytes.
- Same guest/tab, cookie-backed session, local/session storage and unsaved fields before/after.
- Single/multiple selection; reject multiple files for single inputs; empty selection cancellation.
- Missing/directory/relative/network/device paths; approval denial; stale/replayed/cross-owner IDs.
- Timeout, abort while waiting/approving, navigation and tab close; no late file assignment.
- Existing browser manager regression suite; focused upload tests; typecheck/lint/architecture checks.
