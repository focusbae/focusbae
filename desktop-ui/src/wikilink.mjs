// [[Wikilinks]] as decorations, not as a node type.
//
// The text stays plain text in the stored document, so a note written here is
// still a note in Obsidian and no schema version has to change. Only the
// painting is ours: the brackets dim, the target is underlined, and a click
// hands the label to the app to resolve.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Kept in step with workspace/links.js — same shape of target, same limits.
export const LINK = /\[\[([^\[\]\n|]{1,200})(?:\|([^\[\]\n]{0,200}))?\]\]/g;
export const normalize = (label) => label.trim().replace(/\s+/g, " ");

function decorate(doc) {
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(new RegExp(LINK.source, "g"))) {
      const label = normalize(match[1]);
      if (!label) continue;
      const from = pos + match.index;
      const to = from + match[0].length;
      const openEnd = from + 2;
      const closeStart = to - 2;
      const pipe = match[2] === undefined ? -1 : from + 2 + match[1].length;
      found.push(
        Decoration.inline(from, openEnd, { class: "wikilink-bracket" }),
        Decoration.inline(openEnd, pipe < 0 ? closeStart : pipe, {
          class: "wikilink-target",
          "data-wikilink": label,
        }),
        Decoration.inline(closeStart, to, { class: "wikilink-bracket" }),
      );
      if (pipe >= 0)
        found.push(
          Decoration.inline(pipe, closeStart, { class: "wikilink-alias" }),
        );
    }
  });
  return DecorationSet.create(doc, found);
}

// The [[ being typed right now, if the caret is inside one. A link already
// closed is not a query — only an unfinished one asks for suggestions.
const OPEN_LINK = /\[\[([^\[\]\n]{0,200})$/;
function activeQuery(state) {
  const { empty, $from } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 220),
    $from.parentOffset,
    "\n",
    "\n",
  );
  const match = before.match(OPEN_LINK);
  if (!match) return null;
  const after = $from.parent.textBetween(
    $from.parentOffset,
    Math.min($from.parent.content.size, $from.parentOffset + 2),
  );
  return {
    query: match[1],
    from: $from.pos - match[1].length - 2,
    to: $from.pos,
    // Typing inside brackets the editor closed for you should not double them.
    closed: after.startsWith("]]"),
  };
}

// Replaces the [[half-typed with a finished [[Label]] and puts the caret after it.
export function completeLink(editor, active, label) {
  const tail = active.closed ? 2 : 0;
  editor
    .chain()
    .focus()
    .insertContentAt({ from: active.from, to: active.to + tail }, `[[${label}]]`)
    .run();
}

// `open(label)` follows a finished link; `suggest(active | null)` is told about the
// one being typed, so the popup lives in React rather than in a detached DOM node.
export const Wikilink = Extension.create({
  name: "wikilink",
  addOptions() {
    return { open: () => {}, suggest: () => {}, keys: () => false };
  },
  addProseMirrorPlugins() {
    const { open, suggest, keys } = this.options;
    let last = null;
    return [
      new Plugin({
        key: new PluginKey("wikilink"),
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (transaction, old) =>
            transaction.docChanged ? decorate(transaction.doc) : old,
        },
        view: () => ({
          update: (view) => {
            const active = activeQuery(view.state);
            const signature = active
              ? `${active.query}:${active.from}:${active.to}`
              : null;
            if (signature === last) return;
            last = signature;
            suggest(
              active && {
                ...active,
                coords: view.coordsAtPos(active.to),
              },
            );
          },
          destroy: () => {
            last = null;
            suggest(null);
          },
        }),
        props: {
          decorations(state) {
            return this.getState(state);
          },
          // The list owns these keys only while it is open; otherwise the editor
          // keeps them, so Enter still makes a paragraph.
          handleKeyDown(view, event) {
            if (!activeQuery(view.state)) return false;
            return keys(event) === true;
          },
          handleClick(_view, _pos, event) {
            const label = event.target?.closest?.("[data-wikilink]")?.dataset
              ?.wikilink;
            // Plain click follows the link; the usual modifier still places a caret,
            // so a link is editable without deleting it first.
            if (!label || event.metaKey || event.altKey) return false;
            event.preventDefault();
            open(label);
            return true;
          },
        },
      }),
    ];
  },
});
