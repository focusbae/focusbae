# LF-02: Startup, Network and Credentials

Date: 2026-09-10. Contract baseline: v2. Scope: desktop privacy integration,
not the editor shell, local capture sink, sync or enterprise enforcement.

## Decisions

Every launch begins Local, or Strict Local if explicitly persisted. Existing
`token.json`, first-run flags and legacy `user_config.json` do not authorize
network or monitoring. A saved account is unlocked only through Connect account.
Network permissions and foreground/clipboard permissions last for the current
process session. Restart does not silently reconnect an account or restore grants.
This adds deliberate reconnection friction until persistence/consent UX is
qualified, but prevents legacy state from becoming new consent.

The tray Privacy submenu owns explicit native confirmations and revocation.
Permission checks are also enforced below the menu: hiding an item is not the
security boundary. New sensitive settings IPC checks the local main-frame sender;
voice session/media IPC checks the actual voice window. LF-03 still owns the
full legacy IPC/CSP hardening and new workspace IPC contract.

| Purpose | Permission and payload boundary |
| --- | --- |
| Account | Auth exchange/refresh/dashboard code only; POST with allowlisted body fields |
| Calendar | Read-only upcoming events and cloud briefs |
| Cloud commitments | Existing account todo reads/review/status operations |
| Hosted draft | Selected cloud commitment's draft endpoint, separate from reading todos |
| Meeting bot | Explicit selected meeting link to the hosted bot |
| Connected recording | Existing capture's transcript upload; bound to starting account/session |
| Online voice | Existing hosted voice API and configured LiveKit room; screen selection remains explicit |
| Models | Explicit HTTPS model provisioning with bounded approved redirect hosts |
| Updates | Explicit checks; separate confirmation for download; no auto-install on quit |
| Foreground / clipboard | Independent local monitoring permission, off on every launch |
| Legacy activity sync / future workspace sync | Denied; no grant exists in this implementation |

Canonical LF-01 workspace storage does not import this network stack. No new
workspace data is eligible for upload merely because an account connects. New
workspace/account binding and encrypted sync remain LF-14/15, not legacy activity
sync or mutable global token routing.

## Enforcement and Cancellation

`privacy/policy.js` maintains account-generation and per-purpose tickets.
`privacy/network.js` validates purpose, API origin/path and auth payloads, refuses
API redirects, applies a timeout and bounded body reading, aborts revoked requests,
and rejects late response bodies. Revoking one purpose does not abort unrelated
operations. Account changes and Strict Local invalidate every network ticket.

Auth, draft, calendar, todo and recording requests use the gateway. CallManager
also uses it instead of a separate axios client. Its HTTP work and websocket
reconnects are bound to the instance's original ticket. Cleanup terminates the
voice socket and clears reconnect/duration work. Main destroys the voice renderer
on revocation/sign-out so its WebRTC room cannot keep streaming.

The voice renderer has a separate non-persistent Electron session. Ordinary
renderers have no HTTP/WebSocket access. Voice egress requires online-voice
permission and the configured LiveKit host. Updater egress is restricted to the
configured existing R2 host and non-renderer requests. Permission check/request
handlers deny unapproved Chromium media access. Remote fonts and idle LiveKit
prewarming were removed. See Electron's
[session permission documentation](https://www.electronjs.org/docs/latest/api/session)
and [request filtering API](https://www.electronjs.org/docs/latest/api/web-request).

Model provisioning checks every redirect and destroys the active HTTPS request
on revocation; partial bytes are retained, not restarted in the background.
Approved delivery hosts are explicit. A changed CDN host fails closed and needs
review instead of a broad wildcard. Update download cancellation uses the existing
updater's CancellationToken. Strict Local closes Electron connections and disables
future retries; it cannot recall bytes already transferred.

This is application policy, **not an OS firewall or protection against malicious
native code**. New transports, providers and helpers must join the policy and
process tests before use. The dormant Apple Speech helper still contains system
asset provisioning, but `USE_APPLE_BACKEND` remains false. LF-09 must qualify and
separate its provisioning before enabling it; it is not an approved bypass.

## Credentials and Legacy Data

`privacy/credentials.js` uses Electron safeStorage and refuses unavailable or
`basic_text` protection. New credentials are written to a private encrypted
`account.enc.json` via fsync/atomic rename, then decrypted and verified. Only after
that succeeds is legacy `token.json` removed. Corrupt/unavailable secure storage
does not fall back to plaintext. Startup does not unlock the Keychain.

Electron documents macOS Keychain-backed key protection in
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
This protects account credentials, **not SQLite notes, audio, clipboard history
or other application data**. Existing plaintext credentials remain untouched
until explicit connection/migration or sign-out. Never copy them into workspaces.

The legacy `get-token` renderer IPC returns null. Main alone owns access/refresh
tokens; only the scoped LiveKit room token needed by its SDK crosses into the
approved voice renderer. Unsolicited auth callbacks require a native confirmation
before replacing an account. Late exchange/refresh responses cannot overwrite a
later session. JWT parsing establishes local identity only; server authentication
still verifies signatures and permissions.

No startup or successful-recording path drains held transcripts. The compatibility
`retryPendingUploads` entry point is deliberately a no-op. New failed captures
record their starting account ID in the held file; original unknown-owner files
remain unchanged. LF-08 must inspect/import these explicitly, not upload them
using whichever account happens to be active.

The existing recording workflow is still connected: speech runs locally, then
the transcript uploads for hosted processing after explicit permission. Its copy
now states this. Revoking upload access leaves stop controls usable; upload failure
uses the existing held-transcript recovery path. Account-free durable recording is
LF-05 and must not be advertised as complete. Local workspace files survive sign-out.

## Handoff

LF-03 must integrate the qualified runtime and workspace shell with these policy
entry points, not restore the old global auth bypass or automatic startup jobs.
Keep account connection, sync, cloud AI and provisioning separate. Persisting
additional permissions later requires versioned consent and account scoping.

Release checks still needed: real OS Keychain migration in a signed app; actual
signed update downloads/install; live room teardown and capture under revocation;
long-running process-aware egress observation including helpers on supported
hardware; and managed enterprise restrictions at LF-17. Current tests and exact
limits are in LF-02 evidence.
