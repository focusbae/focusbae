# LF-03: Desktop Workspace Shell

Date: 2026-09-11. Contract baseline: v2.

## Runtime and Build

Integrate the LF-00-qualified Electron 43.7.0 and React/react-dom 19.2.7 with
Vite 8.3.0. Electron main remains CommonJS. The renderer contains no Node runtime,
Next server, CDN, remote fonts or authentication dependency. TipTap remains LF-04;
this shell does not yet edit notes. Lucide React 0.577.0 supplies UI icons.

The [Electron release](https://github.com/electron/electron/releases/tag/v43.7.0)
was rechecked during integration. Electron 43 remains the bounded target selected
in LF-00 to avoid the Electron 44 clipboard API migration. Recheck support and
security patches before release. Production build tooling is now pinned to
electron-builder 26.15.3; the existing postinstall succeeds. The macOS workflow's
Node version and fallback Electron target match the qualified runtime. The
workflow still requires its separate signed-release qualification.

`npm start`, `npm run dist` and `npm run dist:all` build the renderer first.
The unsigned arm64 package probe includes the actual main process, renderer,
SQLite and legacy native dependencies. Only its entry point sets temporary
profiles, suppresses OS registration/shortcuts, and supplies test fixtures.
It skips signing and the release afterPack signature-cleanup hook. It is not
a distributable release artifact or proof of Intel support.

## Workspace Ownership

Main creates a private `workspaces/` directory under Electron userData. A small
atomic `catalog.json` registers opaque IDs and generated directory names.
Each workspace retains its independent SQLite identity/local actor. The renderer
cannot supply filesystem locations. External workspace selection, restore and
migration remain LF-08. A missing catalog recovers complete managed workspaces;
corrupt/unreadable state fails visibly instead of making a replacement workspace.

First launch creates My workspace and opens Today. The shell reads canonical
notes, recordings and actions as paginated plain-text overviews. Empty sections
are real empty states. Only workspace name, appearance and Strict Local settings
are editable in LF-03. Workspace settings use expected revisions and UUID request
IDs, and the UI reports save success only after the durable acknowledgment.

Catalog operations are serialized, with a bounded IPC backlog. Switching opens
and validates the next store before releasing the old store. A failed switch
keeps the active store. Starting/running/stopping legacy capture blocks switching.
Requests always carry their original workspace ID and cannot retarget after a
switch. General durable recording remains LF-05.

## Renderer Boundary

The sandboxed context-isolated BrowserWindow uses an in-memory session and the
`focusbae-workspace://app/index.html` document. A main-owned protocol serves only
the built index and allowlisted JS/CSS/PNG assets after containment checks. It
does not expose a general file protocol, filesystem path, URL opener or SQL API.
Navigation, new windows, webviews, downloads and permissions are denied. The CSP
allows only same-origin scripts/styles/images, with no connection, frame, object,
media, inline script or inline style permission.

The preload exposes named methods under `window.focusbaeWorkspace`:

| Method | Input |
| --- | --- |
| `bootstrap()` | none; active workspace, catalog, privacy snapshot and sequence |
| `workspace.list()` | none; opaque IDs and display names |
| `workspace.create({name})` | nonempty name, max 200 characters |
| `workspace.open({workspaceId})` | registered UUID |
| `workspace.update({context, changes})` | LF-01 mutation context; name/preferences |
| `notes.list`, `recordings.list`, `actions.list` | workspaceId, optional bounded offset/limit |
| `privacy.get()` | no credentials or account tokens |
| `privacy.setStrict({enabled})` | boolean; native confirmation through LF-02 |
| `onChange(listener)` | returns an unsubscribe function |

Methods return the contract Result envelope. Main checks the owned window,
exact main frame/document, supported fields, JSON size/depth, workspace scope and
revision. Errors use fixed public messages rather than raw paths/SQL. Events
include entity/workspace ID, revision and monotonic sequence; renderer reloads
canonical state when notified. Overview results omit rich HTML, attachment paths
and arbitrary entity metadata. React renders imported-looking text literally.

The workspace renderer is rejected by legacy IPC registrations as well. This
isolates its authority from connected settings, voice and capture windows; it
does not claim that every historical window has been rewritten with this preload.
Connected account, voice and capture permissions remain owned by LF-02.

## Lifecycle and UX

Closing the workspace hides it and preserves its state. Tray Open Workspace,
the app menu and Dock activation reopen it. Existing foreground onboarding/voice
windows keep activation priority. Closing legacy settings does not demote an open
workspace to an accessory app. Quit waits for queued workspace operations and
for starting/stopping/running capture to settle and drain.

Today, Notes, Recordings, Actions and Settings support keyboard navigation,
light/dark/system themes and narrow windows. A compact selector preserves workspace
switching when sidebar labels are hidden. Record is disabled; editing and semantic
search are explicitly unavailable. No sample notes are created by the application.

## Remaining Release Work

The existing dependency audit still flags legacy axios/ws/updater and native-helper
dependency trees, including tar under Whisper's build dependency chain. This change
does not claim a clean audit. Resolve and requalify those paths in the release gate.
Live signed auth, voice rooms, real capture devices and universal signing/notarization
need their owning hardware/release checks. The shell tests use explicit synthetic
fixtures and a simulated capture drain for lifecycle assertions.

LF-04 can add the editor/search/export API to this boundary; LF-05 can bind general
recording to the workspace service. Reconsider the catalog design when external
workspace registration or recovery/import is implemented, and the IPC execution
model if measured storage work begins to block UI responsiveness.
