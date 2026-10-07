# LF-04b: Linked Notes — Wikilinks, Backlinks, Page Tabs, Graph

Date: 2026-09-21. Owner: Claude. Extends LF-04 (notebook).
Schema version 2 → 3 (`note_links`). Canonical document/schema version stays 1:
**no note content is rewritten by this work.**

## Context

The product owner asked for the notebook to "feel like Obsidian": write in
markdown, open pages as tabs, connect notes to each other, and see a graph.

The repository's own constraint (`the project docs`) is that this must
not become a general-purpose Obsidian clone. The product is an obligation ledger
— who owes what — not a second notebook competing with Obsidian, Granola, Oats,
Harbor and every other capture app shipping the same month.

So the linking layer was built only where it serves the ledger: links connect
notes to **people, recordings and actions** that the workspace already tracks,
and the graph draws the relationships that already exist in the database rather
than inventing a second, decorative set.

## Choice

### 1. Links are text, not a node type

`[[Target]]` and `[[Target|shown text]]` stay plain text in the stored TipTap
document. The editor paints them with ProseMirror decorations
(`desktop-ui/src/wikilink.mjs`); nothing is added to the document schema.

Consequences:

- `contentSchemaVersion` does not change, and no migration touches note bodies.
- A note written here is still a note in Obsidian, and vice versa.
- Export had to stop escaping them: `workspace/portable.js` previously wrote
  `\[\[Priya\]\]`, which no other vault reads. Wikilinks are now emitted verbatim
  and everything around them is still escaped.
- A modifier-click still places the caret, so a link can be edited without
  deleting it first.

### 2. Links are indexed on save, into a derived table

`workspace/links.js` parses a note's links on every save and rewrites its rows in
`note_links` (migration v3). "What points at this?" is then a query, not a scan.

A link may name a page that does not exist yet — that is how a vault grows — so
rows carry a normalised `target_key` and a nullable `target_id`.

`repair()` keeps those rows honest without rewriting any note:

- a page created or restored **claims** the pending links naming its title;
- a page moved to Trash **releases** the links pointing at it.

Without this, following an unresolved link after its page existed would have
created a *second* page with the same title. The E2E test caught exactly that.

A target resolves against note titles first, then the people the workspace knows,
so `[[Priya]]` joins the same ledger entry as a promise she made out loud.

Renaming a page keeps its incoming links (they point at the page id, not the
title). It does not rewrite the link text in other notes — Obsidian does; we
deliberately do not touch note content.

### 3. The graph is over real relationships

`workspace/graph.js` draws what is already stored:

| Edge | Meaning |
| --- | --- |
| note → note | a `[[wikilink]]` |
| note → person | a `[[wikilink]]` that resolves to someone |
| note → recording | a capture saved into that note |
| person → action | an action they own |
| recording → action | the conversation an action was quoted from |

An action nobody owns and nothing proposed is not drawn — it has no place in a
picture of relationships — and that is **not** reported as truncation. `MAX_NODES`
is 600; only hitting that cap sets `truncated`.

### 4. Layout is arithmetic, and is tested as arithmetic

`desktop-ui/src/graph-layout.mjs` is a force simulation run to completion once
and then normalised onto a fixed 900×620 canvas, not an animation:

- **Deterministic** — a seeded PRNG, so the same workspace always draws the same
  picture and the graph is something you can learn the shape of.
- **Static** — no per-frame work, so a long-lived menubar app does not spend
  battery animating a page nobody is watching.
- **Scale-stable** — normalising the settled cloud onto the canvas means a node,
  its label and the gaps between them are the same size in a notebook of six
  pages and one of six hundred. Zoom is what changes that, not how much you have
  written.
- **Bounded** — repulsion is every-pair, so the tick budget shrinks as the graph
  grows: 600 nodes lay out in ~120 ms on this machine, measured, not guessed.

Two earlier versions were wrong and were caught by looking at the rendered
screenshot: the first blew small graphs up until labels collided, the second
collapsed them into an unreadable dot.

### 5. Tabs hold pages, not editors

Only the active tab mounts a `NoteEditor`. The others are a title and an id, so
nine open pages cost nine titles rather than nine autosaving editors. Switching
tabs runs through the same `act()` path as every other navigation, which flushes
the page being left before loading the next.

Closing the active tab moves to its neighbour — right, or left when it was last.
The strip holds 9; opening a tenth closes the oldest page you are not looking at.

The strip itself lives in the shell (`main.jsx`), not in `Notebook`, so leaving
Notes for Actions and coming back finds the same pages open on the page you were
reading. Arriving with a note to open (from a recording) wins once and is then
cleared, so it does not override the strip on every later visit.

### 6. Completion for a half-typed `[[`

A link is only useful if you do not have to remember the exact title. Typing
`[[` opens a list of pages and people; Enter or Tab accepts, Escape leaves the
brackets alone so writing a literal `[[` stays possible, and Enter goes back to
being Enter the moment the list is closed.

No dependency was added for this. `@tiptap/suggestion` is not in the tree and
this repository pins its editor packages deliberately, so the plugin is ~60 lines
in `desktop-ui/src/wikilink.mjs`: it reports the query and caret position, React
owns the popup, and the plugin borrows the arrow/Enter/Tab/Escape keys only while
the list is open.

Ranking (`links.suggest`): titles that *start* with what was typed come before
titles that merely contain it, shorter before longer, then recency. With nothing
typed yet it offers recent pages **and** the people you have something open with,
rather than letting one list crowd out the other — a link to a person is a link
into the ledger, which is the point of the feature.

### 7. One page's connections

`GraphView` takes a `focusId`; `neighbourhood()` in `graph-layout.mjs` cuts the
graph down to that page and what it touches, and the layout runs over the
subgraph so the neighbourhood uses the whole canvas instead of sitting in a
corner of the workspace picture. "Only this page" turns it off. There is one
graph tab, renamed rather than duplicated, so opening connections from three
pages in turn does not leave three tabs behind.

## Files

| File | Change |
| --- | --- |
| `workspace/links.js` | new — parse, resolve, index, repair, backlinks, suggest |
| `workspace/graph.js` | new — the workspace as nodes and edges |
| `workspace/schema.js` | migration v3: `note_links` + two indexes |
| `workspace/store.js` | `_save` indexes a note's links |
| `workspace/portable.js` | wikilinks survive markdown export |
| `workspace/ipc.js`, `workspace-preload.js` | `notes.links`, `notes.resolveLink`, `notes.linkTargets`, `notes.graph` |
| `desktop-ui/src/wikilink.mjs` | new — decorations, click-to-follow, `[[` completion |
| `desktop-ui/src/graph-layout.mjs` | new — the force layout and `neighbourhood()`, on their own |
| `desktop-ui/src/graph-view.jsx` / `.css` | new — the drawing, filters, zoom |
| `desktop-ui/src/notebook.jsx` / `.css` | tabs, link panel, graph tab |
| `desktop-ui/src/main.jsx` | holds the open pages; Notebook survives a visit to Actions |

## Tests

| Test | Covers |
| --- | --- |
| `tests/local-first/links.test.js` | parsing, dedupe, aliases, claim/release on create/trash/restore, rename, person resolution, graph edges, export round trip, suggestion ranking and bounds |
| `tests/workspace-shell/notebook-ipc.test.js` | the three channels: scope, label bounds, backlinks, graph |
| `tests/workspace-shell/graph-layout.test.js` | determinism, canvas bounds, separation, 600-node timing, neighbourhood depth and dangling edges |
| `tests/workspace-shell/links-e2e.cjs` | write a link to a page that does not exist, follow it, return by backlink, complete a `[[` by keyboard, Escape leaving Enter alone, one page's connections, the strip surviving a visit to Actions, filter and click the graph, close tabs |

Full suite at implementation: `npm test` 136 passing, 0 failing;
`npm run test:local:e2e` passing, including the new check
"wikilinks, backlinks, page tabs and the workspace graph".

An unrelated pre-existing failure in `tests/local-first/reminders.test.js` was
fixed here: it asserted the migration backup was named `schema-1-to-2-`, which
the v3 migration invalidated. It now asserts against `SCHEMA_VERSION`.

## Privacy and Migration

No new network access, no new helper process, no model, no new dependency. Migration v3 creates one
table and two indexes; existing notes index their links the next time they are
saved, and `graph.js` also matches on title so rows written before `repair()`
existed still draw correctly.

## Reconsideration Trigger

If the graph becomes something people open more than the ledger itself, it has
stopped being a way to see who owes what and has become a second notebook —
which is the thing this project said it would not build.

---

## Addendum: Commitments From a Page You Typed (2026-09-21)

Actions only ever came from recordings: `extractActions(store, recordingId, …)`
is keyed on a recording and is called from `recording/service.js` alone. A
meeting you could not record — a phone call, a corridor conversation, anyone who
said no to being recorded — produced nothing, and three lines typed afterwards is
the most common way a meeting actually gets captured.

`workspace/note-extraction.js` reads a page and proposes the commitments on it
through the same machinery a recording uses. The engine is the one Apple's own
Writing Tools run on: `SystemLanguageModel`, already wired here as
`local-ai/apple-extract`. Nothing is downloaded and nothing leaves the Mac.

What is kept from the recording path:

- **Grounding.** A quote that is not in the page verbatim is dropped. Checked
  twice — the helper checks it against the piece it was given, and this checks it
  against the page, because the evidence points at the page.
- **Proposals only.** Every commitment lands as `proposed`. Nothing is accepted.
- **The page is never rewritten.** Its revision does not change.

What differs, and why:

- **"I" means you.** In a transcript the speaker is whoever was talking; on a page
  you wrote, first person is the account owner. `resolveOwner` is called with a
  `self` speaker, so "I'll send the pricing sheet" is yours and "Priya will send
  the contract" is hers.
- **Proposals are keyed on the words, not the revision.** Re-reading a page you
  have since edited does not offer the same sentence again, and a proposal you
  rejected is not resurrected by a second look.

Evidence grew a `sourceKind` (`transcript` | `note`, defaulting to `transcript`,
so stored actions need no migration). `segmentId` keeps its name and now means
"the source this quote came from". Everything that resolves evidence branches on
it: quote verification in `store._action`, staleness in `_evidenceState`,
`actions.detail` (which returns `noteId`/`noteTitle` instead of a recording), and
the graph, which now joins a page to the actions it proposed.

The fallback path on Macs without Apple Intelligence is the same sentence rules
the recording path falls back to, and it is noisier in the same way: it reads
"The market will grow next year" as a commitment because it cannot tell a
prediction from a promise. That is asserted in the tests rather than hidden —
both paths only ever propose, and rejecting takes one click.

| File | Change |
| --- | --- |
| `workspace/note-extraction.js` | new — pieces, grounding, owner, proposal keys |
| `workspace/domain.js` | evidence carries `sourceKind` |
| `workspace/store.js` | quote verification and staleness per source kind |
| `workspace/actions.js` | evidence detail resolves a page |
| `workspace/graph.js` | page → action edge |
| `workspace/ipc.js`, `workspace-preload.js` | `notes.findCommitments` |
| `desktop-ui/src/notebook.jsx` | "Find commitments on this page" |
| `desktop-ui/src/actions.jsx`, `main.jsx` | evidence opens the source page |
| `tests/local-first/note-extraction.test.js` | new — 7 tests |

One bug worth recording: the first version of the IPC handler wrapped the call in
`catalog.serialize`, which deadlocked — every channel already runs inside
`catalog.serialize`, so the inner call waited on the operation waiting on it.

`npm test` 143 passing. `npm run test:local:e2e` passing, with a new check:
"commitments written on a page reach Actions and People".

---

## Addendum: Rewriting a Selection (2026-09-21)

Apple Notes, Granola and Harbor all offer Writing Tools now, so a notes app
without them reads as behind. Apple gives them free to apps built on AppKit,
UIKit or WebKit text views; this editor is Chromium inside Electron, which draws
its own text, so the menu had to be ours. The model behind it did not: the same
`SystemLanguageModel` helper gained a `--rewrite` mode, so there is no new
binary, no new build script and no new availability check.

Three styles — **Proofread** (spelling, grammar, punctuation only), **Make
clearer**, **Shorten** — acting on the selection, replacing it in place, undoable
with one ⌘Z. No preview, because undo is the preview and a preview dialog would
be the larger feature.

Two guards, both found by running it on real sentences rather than by reasoning
about it:

1. **Point of view.** The first version turned *"I need to get her the pricing
   sheet"* into *"you will get her the pricing sheet"*. In a ledger that reverses
   who owes what. The instructions now state that the author's "I" and "we" stay
   "I" and "we", and that who promised what must not change.
2. **Numbers.** Every digit run in the selection must survive the rewrite, or the
   rewrite is refused and the words are kept (`REWRITE_UNSAFE`). Thousands
   separators may be added or dropped — `40000` and `40,000` compare equal —
   because the model reformats amounts and that is not a change of fact. Silently
   altering an amount is worse than not rewriting at all.

Where Apple Intelligence is unavailable, rewriting is **refused**
(`REWRITE_UNAVAILABLE`), never downgraded to something weaker. Extraction has a
rule fallback because a missed proposal costs nothing; there is no acceptable
fallback for rewriting a person's own sentences.

Nothing is stored: text in, text out. The note is not read by the channel and not
written by it; only the editor changes, and only where the user had selected.

| File | Change |
| --- | --- |
| `local-ai/apple-extract/Sources/main.swift` | `--rewrite` mode, three instruction sets |
| `local-ai/extraction-runtime.js` | `rewrite()`, number preservation, distinct codes |
| `workspace/ipc.js`, `workspace-preload.js` | `notes.rewrite`, bounded before the model |
| `desktop-ui/src/notebook.jsx` / `.css` | the Rewrite control and its status |
| `tests/models/rewrite.test.js` | new — 5 tests, none of which run the model |

The unit tests deliberately do not invoke Apple's model: they stub the helper and
test what surrounds it, which is where a rewrite can actually do harm. The E2E
does use whatever the machine has, and asserts both outcomes — corrected and
undoable, or refused and untouched.

`npm test` 148 passing. `npm run test:local:e2e` passing, with a new check:
"on-device rewriting corrects a selection, or plainly says it cannot".
