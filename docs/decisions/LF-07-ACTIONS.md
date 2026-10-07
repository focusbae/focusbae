# LF-07a: Local Action Workspace

Date: 2026-09-14. Status: local action workflow implemented; full LF-07 remains
IN_PROGRESS because opt-in reminders and the local nudge adapter are not included.
Contract v2 lifecycle rules remain authoritative.

## Decision

Use the canonical SQLite action records already implemented in LF-01. Add a narrow
main-process action adapter and renderer IPC rather than importing the connected
todo API or making local UUIDs account-owned. Actions remain available with no
account and under Strict Local.

The desktop uses six derived views:

- Review: proposed AI or deterministic local suggestions only.
- My actions: accepted or deferred actions owned by the workspace-local actor.
- Waiting on: accepted or deferred actions explicitly assigned to another person.
- Unassigned: accepted or deferred actions with unknown ownership.
- Completed: done actions.
- Archived: dismissed/dropped actions.

`Waiting on` is not a stored lifecycle state. Manual creation starts accepted.
Proposals remain proposed until an explicit Accept command. An unassigned proposal
cannot be accepted through the UI until ownership is corrected and saved. Stale
or deleted evidence is visible and cannot be accepted through the repository.

## Ownership

`self` continues to resolve to the stable workspace-local actor, independent of a
signed-in account. A manually named `person` gets an opaque local UUID and a local
display label stored in action JSON as `ownerLabel`. This adds no database column
or migration. It is not an enterprise directory identity and must be mapped rather
than reused if sync or contacts are implemented. `unknown` has neither ID nor label.

## Interaction and Provenance

The Actions page is an unframed list/detail workspace consistent with the local
notebook. Commands cover create, edit, assign, due date, priority, accept, dismiss,
defer, resume, complete, reopen and confirmed local deletion. Long titles wrap.
All views and controls remain reachable in the compact layout.

Evidence is a read-only quote snapshot with source type and transcript timestamp.
The renderer can navigate to the owning recording but receives no arbitrary path.
Public evidence text is capped at 4,000 characters per quote for bounded rendering;
the complete canonical snapshot remains in SQLite. Missing or changed sources do
not erase accepted action text. React renders imported/model text as text.

Every mutation requires workspace scope, a unique request ID and expected revision
for edits/transitions/deletion. IPC validates exact fields and the owning main
frame. Native confirmation owns deletion. No operation sends messages, executes a
task, enables monitoring, requests Accessibility, or contacts a server.

## Reminders

Notifications are disabled by default. After an explicit workspace preference,
accepted/deferred self-owned actions due today or overdue can produce one aggregate
native notification per local calendar day. Snooze state is stored separately from
the action so background checks cannot create edit revision conflicts. Today and
Actions show canonical due counts. Notification checks do not request Accessibility
or use foreground monitoring.

Real Notification Center permissions, timezone changes and DST boundaries remain
release acceptance work. Sending messages and autonomous execution remain excluded.
