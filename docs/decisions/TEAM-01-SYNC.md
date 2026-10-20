# TEAM-01: Team Workspaces and Sync

Date: 2026-10-20. Status: implemented behind configuration; off in release builds
until the team service has a public address (`FOCUSBAE_TEAM_URL`).
Code: `team/`, `privacy/local-policy.js`. Tests: `tests/team/`, `npm run test:local:network:team`.

## What a team workspace is

An ordinary local workspace with a `team.sqlite` file beside its `workspace.sqlite`.
The file's presence is what makes it a team workspace. Personal workspaces are never
opened, read or migrated by the team code, and older app versions ignore the file
and open the workspace as a plain local one.

Rejected: adding team tables to `workspace.sqlite`. That bumps the schema of every
workspace, including Personal ones, blocks downgrades for people who never use
teams, and mixes server state into the canonical local store.

## What leaves the Mac

Only actions the person accepted (or later deferred, completed or dropped): title,
status, due date, owner, who it is owed to, the quote it came from and the name of
the note or recording. Never audio, transcripts, notes or proposals. Deleting an
action here withdraws it from the team. The Actions page of a team workspace says so.

## Network permission

A third purpose, `team`, joins `models` and `updates` in the local policy. It is on
only while a team account is connected (an explicit choice in Settings), is blocked by
Strict Local, and every change bumps the policy epoch so requests prepared under the
old rules are cancelled (`policy.assert(purpose, ticket)` before and after the token
refresh). With no saved session the Keychain is never touched at startup;
`test:local:network:team` proves zero network and zero sensitive calls with the team
feature configured but no account.

## Connecting an account (RFC 8252, RFC 7636)

The app opens the team service's `/connect/desktop` page in the browser with a PKCE
S256 challenge, a random state and the port of a listener bound to `127.0.0.1` only.
The signed-in browser creates a one-time grant (hashed at rest, two minutes, single
use) and redirects to the loopback listener. The app redeems the grant with its
verifier for a normal session. The refresh token is encrypted with Electron
`safeStorage` (a key held in the macOS Keychain) in a `0600` file.

This works with any sign-in method the web supports (email link, Google, later SSO)
without the app handling credentials, and a grant intercepted on its way to the
loopback is useless without the verifier. Rejected: a custom URL scheme
(`focusbae://`), which any app can register and which the open-source release removed;
and embedding sign-in in an app window, which RFC 8252 advises against.

## Sync model

Push, then pull, in three phases so the workspace queue is never held during network
calls (holding it would block the window and has deadlocked this codebase before):

1. **Plan** (under the workspace queue): for each local action, the payload it would
   share and a hash of it; unchanged hashes are skipped.
2. **Exchange** (network): `share_commitment` with the server version this Mac last
   saw; `unshare_commitment` for deleted ones; then `pull_changes(cursor)`.
3. **Apply** (under the queue, after checking the same workspace is still open): record
   what was sent, store the pull, and apply teammates' status changes to this Mac's
   own actions through the normal store API (revision-checked, idempotent).

This is the push/pull-with-cursor shape of Replicache and Linear's sync engine, kept
deliberately small: commitments are a few hundred rows per team, so the server returns
every visible id on each pull and the client drops anything it may no longer see
(removed from a team, unshared) without a separate tombstone protocol.

**Conflicts.** The server holds a `version` per commitment. A share carries the
version this Mac last saw; if someone changed it since, the server refuses ("changed
elsewhere"), the pull brings their change, the Mac applies it, and the next round
resends this Mac's other edits on top of it. A stale copy can therefore never
overwrite a teammate's status change, and a local edit made meanwhile is not lost.
Status changes from teammates follow the local lifecycle rules, taking two steps when
needed (done → reopen → deferred).

**Removal.** If the server says the person is no longer a member, the synced copy
(ledger, directory, mappings) is cleared and the binding marked `removed`; their own
local actions, notes and recordings stay.

## Who owes whom

`owner` is the action's own owner (`self` is sent as `{self: true}` and resolved by the
server, so learning one's person id later does not change the payload). `counterparty`
is chosen on the Mac and stored in `team.sqlite` `mappings`; with no choice, it is
suggested only when the conversation makes it unambiguous: exactly one other identified
person, or the person themself when someone else made the promise. Explicit choices
win, including choosing nobody.

## Notes and attachments (2026-10-21)

A note written in a team workspace syncs to the person's **My notes** (private) until
they choose a team in the note header ("Visible to"). Nothing is sent before the first
pull has said which space is My notes, so a note is never sent to a guessed place. The
choice lives in `team.sqlite` `note_spaces`; only teams the person can edit are offered.

Until co-editing, only the author changes a note's content; teammates read and comment
on the web, and the author or an admin can share it with another team or a guest. Notes
use the same version guard as commitments. The web renders the stored TipTap JSON with
TipTap's static renderer from an allow-list of the node and mark types this app writes,
never as HTML, and keeps only http(s) and mailto links.

Attachments upload after their note exists (storage checks the note), once per content
hash, to a private bucket at `workspace/note/attachment`; whoever can see the note can
read them. HEIC photos send their PNG preview, since browsers cannot show HEIC. Files
over the service's 50 MB limit are listed but stay on this Mac, and the web says so. One
round holds at most 120 MB of uploads in memory; the rest go in later rounds.

## Open

- Sync only runs for the open workspace; background sync of other team workspaces.
- Team spaces other than "everyone" from the Mac (choose the team when accepting).
- Teammates' notes on the Mac (they are pulled into `remote_notes`; shown on the web today).
- Co-editing with Yjs (TEAM_PLAN weeks 7–8), which replaces author-only snapshots.
