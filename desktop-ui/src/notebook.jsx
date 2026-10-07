import React, { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeft,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Quote,
  Code,
  Link,
  Undo2,
  Redo2,
  Pin,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PinOff,
  Trash2,
  RotateCcw,
  Plus,
  Search,
  Upload,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  FileText,
  Check,
  LoaderCircle,
  CornerUpLeft,
  CornerUpRight,
  UserRound,
  Network,
  ListChecks,
  Wand,
  Paperclip,
} from "lucide-react";
import { SaveQueue } from "./save-queue.mjs";
import { Wikilink, completeLink } from "./wikilink.mjs";
import { NoteAttachment, uploadAttachment } from "./note-attachment.mjs";
import { GraphView } from "./graph-view.jsx";
import "./notebook.css";

const api = window.focusbaeWorkspace;
const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
const context = (workspaceId, revision) => ({
  workspaceId,
  clientRequestId: crypto.randomUUID(),
  ...(revision ? { expectedRevision: revision } : {}),
});
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
}
function Tool({ label, icon: Icon, active, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...props}
    >
      <Icon size={17} strokeWidth={1.6} />
    </button>
  );
}
function ErrorMessage({ error, retry }) {
  return (
    <div role="alert" className="error">
      <span>{error.message}</span>
      {retry && <Tool label="Retry saving" icon={RotateCcw} onClick={retry} />}
    </div>
  );
}
function safeLink(value) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function LinkDialog({ editor, close }) {
  const ref = useRef(null);
  const [url, setUrl] = useState(editor.getAttributes("link").href ?? "");
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-label="Edit link" onCancel={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!safeLink(url)) return;
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
          close();
        }}
      >
        <div className="dialog-heading">
          <h2>Edit link</h2>
          <Tool label="Close link dialog" icon={X} onClick={close} />
        </div>
        <label htmlFor="note-link">URL</label>
        <input
          id="note-link"
          autoFocus
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
        />
        <div className="dialog-actions">
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              close();
            }}
          >
            Remove link
          </button>
          <button type="submit" className="primary" disabled={!safeLink(url)}>
            Apply
          </button>
        </div>
      </form>
    </dialog>
  );
}

function FolderDialog({ mode, folder, parentPath, close, submit }) {
  const ref = useRef(null);
  const [name, setName] = useState(mode === "rename" ? folder.name : "");
  useEffect(() => {
    ref.current.showModal();
  }, []);
  const heading = mode === "rename" ? "Rename folder" : "New folder";
  return (
    <dialog ref={ref} className="folder-dialog" aria-label={heading} onCancel={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          submit(name.trim());
          close();
        }}
      >
        <div className="dialog-heading">
          <h2>{heading}</h2>
          <Tool label={`Close ${heading.toLowerCase()} dialog`} icon={X} onClick={close} />
        </div>
        <label htmlFor="folder-name">Name</label>
        <input
          id="folder-name"
          autoFocus
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="For example, Clients"
        />
        {mode === "create" && (
          <p className="dialog-note">
            {parentPath ? `Inside ${parentPath}` : "At the top level"}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {mode === "rename" ? "Rename" : "Create folder"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function FolderMenu({ folder, busy, create, rename, remove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const pick = (fn) => () => {
    setOpen(false);
    fn();
  };
  return (
    <span className="folder-menu" ref={ref}>
      <Tool
        label="Folder options"
        icon={MoreHorizontal}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <span className="folder-menu-list" role="menu" aria-label={`${folder.name} options`}>
          <button type="button" role="menuitem" onClick={pick(create)}>
            New folder inside
          </button>
          <button type="button" role="menuitem" onClick={pick(rename)}>
            Rename
          </button>
          <button type="button" role="menuitem" className="danger" onClick={pick(remove)}>
            Remove folder
          </button>
        </span>
      )}
    </span>
  );
}
function DiscardDialog({ close, reload }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-label="Discard unsaved changes" onCancel={close}>
      <h2>Discard unsaved changes?</h2>
      <p>
        The saved note will replace this draft. Export a recovery copy first to
        keep your writing.
      </p>
      <div className="dialog-actions">
        <button onClick={close}>Keep writing</button>
        <button onClick={reload}>Discard and reload</button>
      </div>
    </dialog>
  );
}
// The list under a half-typed [[. It is a listbox rather than a menu because that
// is what it is: the editor keeps the caret and the keys are borrowed, so a
// screen reader should hear a list of options, not a new place to be.
function LinkSuggestions({ items, highlight, coords, choose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  if (!items.length) return null;
  // Flipped above the caret when there is no room below it.
  const below = coords.bottom + 240 < window.innerHeight;
  return (
    <ul
      ref={ref}
      className="link-suggestions"
      role="listbox"
      aria-label="Link to"
      style={{
        left: Math.min(coords.left, window.innerWidth - 280),
        ...(below
          ? { top: coords.bottom + 4 }
          : { bottom: window.innerHeight - coords.top + 4 }),
      }}
    >
      {items.map((item, index) => (
        <li key={`${item.kind}:${item.id ?? item.label}`}>
          <button
            role="option"
            aria-selected={index === highlight}
            className={index === highlight ? "active" : ""}
            // The editor must keep the caret, so the press never moves focus.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(item);
            }}
          >
            {item.kind === "person" ? (
              <UserRound size={13} />
            ) : (
              <FileText size={13} />
            )}
            <span className="link-suggestion-label">{item.label}</span>
            <span className="hint">
              {item.kind === "person"
                ? item.open
                  ? `${item.open} open`
                  : "person"
                : "page"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// What this note points at, and what points back. Both come from the same derived
// table the graph reads, so the panel and the graph never disagree.
function LinkPanel({ note, version, openNote, openLink, openPerson }) {
  const [links, setLinks] = useState(null);
  useEffect(() => {
    let current = true;
    unwrap(api.links.forNote({ workspaceId: note.workspaceId, id: note.id }))
      .then((value) => current && setLinks(value))
      .catch(() => current && setLinks(null));
    return () => {
      current = false;
    };
  }, [note.workspaceId, note.id, version]);
  if (!links || (!links.outgoing.length && !links.backlinks.length)) return null;
  return (
    <section className="link-panel" aria-label="Links">
      {links.outgoing.length > 0 && (
        <div>
          <h3>
            <CornerUpRight size={13} />
            Links from this page
          </h3>
          <ul>
            {links.outgoing.map((link) => (
              <li key={`${link.kind}:${link.label}`}>
                <button
                  className={`link-chip ${link.resolved ? "" : "unresolved"}`}
                  onClick={() =>
                    link.kind === "person"
                      ? openPerson(link.id)
                      : link.resolved
                        ? openNote(link.id)
                        : openLink(link.label)
                  }
                >
                  {link.kind === "person" && <UserRound size={12} />}
                  {link.label}
                  {!link.resolved && <span className="hint">create</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {links.backlinks.length > 0 && (
        <div>
          <h3>
            <CornerUpLeft size={13} />
            {links.backlinks.length === 1
              ? "1 page links here"
              : `${links.backlinks.length} pages link here`}
          </h3>
          <ul>
            {links.backlinks.map((link) => (
              <li key={link.id}>
                <button
                  className="link-chip"
                  onClick={() => openNote(link.id)}
                >
                  {link.title || "Untitled"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function NoteEditor({
  note,
  folders,
  moveNote,
  pagesHidden,
  togglePages,
  flushRef,
  changed,
  remove,
  restore,
  purge,
  exportNote,
  findCommitments,
  finding,
  showConnections,
  reloadNote,
  back,
  showBack,
  openNote,
  openLink,
  openPerson,
}) {
  const [title, setTitle] = useState(note.title);
  const [status, setStatus] = useState("Saved on this Mac");
  const [error, setError] = useState(null);
  const [pinned, setPinned] = useState(note.pinned);
  const [linkOpen, setLinkOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const warnings = note.importWarnings;
  const pendingPaste = useRef(null);
  const titleRef = useRef(null);
  const fileRef = useRef(null);
  const mounted = useRef(true);
  const onChanged = useRef(changed);
  onChanged.current = changed;
  const [linkVersion, setLinkVersion] = useState(0);
  const [suggestion, setSuggestion] = useState(null);
  const [targets, setTargets] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(null);
  const [rewriting, setRewriting] = useState(false);
  // The editor is created once, so these read the current props and state.
  const follow = useRef(null);
  follow.current = (label) => openLink(label);
  const keys = useRef(() => false);
  const queueRef = useRef(null);
  if (!queueRef.current)
    queueRef.current = new SaveQueue({
      note,
      write: (input) => unwrap(api.notes.update(input)),
      changed: (value, failure, canonical) => {
        if (!mounted.current) return;
        setStatus(value);
        setError(failure);
        if (canonical) {
          onChanged.current(canonical);
          // Saving is what re-indexes the links, so the panel refreshes with it.
          setLinkVersion((count) => count + 1);
        }
      },
    });
  const queue = queueRef.current;
  const attachFiles = (items, position) => {
    if (note.deletedAt || pendingPaste.current || !items.length) return;
    const selected = Array.from(items);
    if (selected.length > 20) { setError(new Error("Attach up to 20 files at a time.")); return; }
    setPasting(true);
    setError(null);
    editor.setEditable(false);
    pendingPaste.current = (async () => {
      await queue.flush();
      if (position != null) editor.commands.setTextSelection(position);
      for (const file of selected) {
        const result = await uploadAttachment(file, note.workspaceId, note.id);
        if (!mounted.current) return;
        editor.commands.insertContent([{ type: "noteAttachment", attrs: { id: result.id } }, { type: "paragraph" }]);
        // Save each successful file before starting the next; one failed file
        // must not discard the attachments that already finished.
        await queue.flush();
        if (result.warning) setError(new Error(result.warning));
      }
    })().catch((failure) => {
      if (mounted.current) setError(failure);
    }).finally(() => {
      if (mounted.current) { editor.setEditable(true); setPasting(false); }
      pendingPaste.current = null;
    });
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          isAllowedUri: safeLink,
        },
        trailingNode: false,
      }),
      Wikilink.configure({
        open: (label) => follow.current(label),
        suggest: (active) => setSuggestion(active),
        keys: (event) => keys.current(event),
      }),
      NoteAttachment.configure({ workspaceId: note.workspaceId, noteId: note.id }),
    ],
    content: note.content,
    editable: !note.deletedAt,
    editorProps: {
      attributes: {
        "aria-label": "Note body",
        role: "textbox",
        "aria-multiline": "true",
        spellcheck: "true",
      },
      handleClick: (_view, _pos, event) => {
        if (event.target.closest("a")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const items = event.dataTransfer?.files;
        if (items?.length) {
          event.preventDefault();
          attachFiles(items, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        }
        return true;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.files;
        if (items?.length) {
          event.preventDefault();
          attachFiles(items);
          return true;
        }
        if (pendingPaste.current || note.deletedAt) return true;
        const html = event.clipboardData?.getData("text/html");
        if (!html) return false;
        event.preventDefault();
        setPasting(true);
        view.dom.setAttribute("contenteditable", "false");
        pendingPaste.current = unwrap(
          api.documents.convert({ workspaceId: note.workspaceId, html }),
        )
          .then((result) => {
            if (!mounted.current) return;
            // The editor is locked while parsing, so the captured selection stays valid.
            // Pasting is not importing: every editor drops a web page's styling, so
            // the cleanup's notes are noise here. Import details stay for imported files.
            editor.commands.insertContent(result.content.content);
          })
          .catch((failure) => {
            setError(failure);
            throw failure;
          })
          .finally(() => {
            view.dom.setAttribute("contenteditable", "true");
            setPasting(false);
            pendingPaste.current = null;
          });
        pendingPaste.current.catch(() => {});
        return true;
      },
    },
    onUpdate: ({ editor: current }) =>
      queue.edit({ content: current.getJSON() }),
  });
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? {
            bold: current.isActive("bold"),
            italic: current.isActive("italic"),
            underline: current.isActive("underline"),
            bulletList: current.isActive("bulletList"),
            orderedList: current.isActive("orderedList"),
            blockquote: current.isActive("blockquote"),
            codeBlock: current.isActive("codeBlock"),
            link: current.isActive("link"),
            heading: current.getAttributes("heading").level ?? 0,
            undo: current.can().undo(),
            redo: current.can().redo(),
          }
        : {},
  });
  useEffect(() => {
    mounted.current = true;
    const flush = async () => {
      await pendingPaste.current;
      return queue.flush();
    };
    flushRef.current = flush;
    const beforeUnload = (event) => {
      if (queue.dirty || pendingPaste.current) {
        event.preventDefault();
        event.returnValue = false;
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      queue.dispose();
      if (flushRef.current === flush) flushRef.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [queue, flushRef]);
  useEffect(() => {
    if (!note.title && !note.deletedAt) titleRef.current?.focus();
  }, []);
  // What the half-typed [[ could name. Asked for on every keystroke inside the
  // brackets, debounced, and dropped if a later query answers first.
  const query = suggestion?.query ?? null;
  const open = query !== null && dismissed !== query;
  useEffect(() => {
    if (!open) {
      setTargets([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      unwrap(api.links.targets({ workspaceId: note.workspaceId, query }))
        .then((items) => {
          if (!current) return;
          setTargets(items);
          setHighlight(0);
        })
        .catch(() => current && setTargets([]));
    }, 90);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, note.workspaceId, linkVersion]);
  const choose = (item) => {
    completeLink(editor, suggestion, item.label);
    setSuggestion(null);
    setTargets([]);
  };
  keys.current = (event) => {
    if (!open || !targets.length) return false;
    if (event.key === "Escape") {
      setDismissed(query);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      setHighlight(
        (index) =>
          (index + (event.key === "ArrowDown" ? 1 : targets.length - 1)) %
          targets.length,
      );
      return true;
    }
    // Tab and Enter both accept; Enter alone would make writing a literal [[x
    // impossible, which is why Escape leaves the list closed until the query moves.
    if (event.key === "Enter" || event.key === "Tab") {
      choose(targets[highlight]);
      return true;
    }
    return false;
  };
  // Rewrites the selection with Apple's on-device model. Your words are replaced
  // in place and one undo puts them back, which is the only reason this is safe to
  // do without a preview.
  const rewrite = async (style) => {
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      setError(new Error("Select the words to rewrite first."));
      return;
    }
    const text = editor.state.doc.textBetween(from, to, "\n", "\n");
    setRewriting(true);
    setError(null);
    try {
      const rewritten = await unwrap(
        api.notes.rewrite({ workspaceId: note.workspaceId, style, text }),
      );
      if (!mounted.current) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, rewritten.split("\n").join("\n"))
        .run();
      setStatus("Rewritten - undo restores your words");
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      if (mounted.current) setRewriting(false);
    }
  };
  const tools = [
    ["Bold", Bold, "bold", () => editor.chain().focus().toggleBold().run()],
    [
      "Italic",
      Italic,
      "italic",
      () => editor.chain().focus().toggleItalic().run(),
    ],
    [
      "Underline",
      Underline,
      "underline",
      () => editor.chain().focus().toggleUnderline().run(),
    ],
    [
      "Bullet list",
      List,
      "bulletList",
      () => editor.chain().focus().toggleBulletList().run(),
    ],
    [
      "Numbered list",
      ListOrdered,
      "orderedList",
      () => editor.chain().focus().toggleOrderedList().run(),
    ],
    [
      "Quote",
      Quote,
      "blockquote",
      () => editor.chain().focus().toggleBlockquote().run(),
    ],
    [
      "Code block",
      Code,
      "codeBlock",
      () => editor.chain().focus().toggleCodeBlock().run(),
    ],
    ["Edit link", Link, "link", () => setLinkOpen(true)],
  ];
  return (
    <article
      className="note-page"
      aria-label={note.deletedAt ? "Deleted note" : "Note editor"}
    >
      <div className="note-meta">
        <div className="note-meta-left">
          {togglePages && (
            <span className="pages-toggle">
              <Tool
                label={pagesHidden ? "Show pages" : "Hide pages"}
                icon={pagesHidden ? PanelLeftOpen : PanelLeftClose}
                onClick={togglePages}
              />
            </span>
          )}
          {showBack && (
            <Tool label="Back to notes" icon={ArrowLeft} onClick={back} />
          )}
          <span>
            {note.deletedAt
              ? "In Trash"
              : note.kind === "daily"
                ? new Intl.DateTimeFormat("en", {
                    weekday: "long",
                    timeZone: "UTC",
                  }).format(new Date(`${note.dailyDate}T12:00:00Z`))
                : "Notebook"}
          </span>
          {!note.deletedAt && note.kind !== "daily" && moveNote && folders.length > 0 && (
            <>
              <span className="note-folder-sep" aria-hidden="true">/</span>
              <select
              className="note-folder"
              aria-label="Folder for this page"
              value={note.folderId ?? ""}
              onChange={(event) => moveNote(note, event.target.value || null)}
            >
              <option value="">Unfiled</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.path}
                </option>
              ))}
            </select>
            </>
          )}
        </div>
        <div className="note-actions">
          {!note.deletedAt && (
            <Tool
              label={pinned ? "Unpin note" : "Pin note"}
              icon={pinned ? PinOff : Pin}
              active={pinned}
              onClick={() => {
                setPinned(!pinned);
                queue.edit({ pinned: !pinned });
              }}
            />
          )}
          {note.deletedAt ? (
            <>
            <button onClick={() => restore(queue.note)}>
              <RotateCcw size={16} />
              Restore
            </button>
            <button onClick={() => purge(queue.note)}><Trash2 size={16} />Delete permanently</button>
            </>
          ) : (
            <>
              <Tool
                label="Find commitments on this page"
                icon={ListChecks}
                disabled={finding}
                aria-busy={finding}
                onClick={() => findCommitments(queue.note)}
              />
              <Tool
                label="Show this page's connections"
                icon={Network}
                onClick={() => showConnections(queue.note)}
              />
              <Tool
                label="Export this note"
                icon={Download}
                onClick={() => exportNote(queue.note)}
              />
              <Tool
                label="Move note to Trash"
                icon={Trash2}
                onClick={() =>
                  flushRef
                    .current()
                    .then((canonical) => remove(canonical))
                    .catch(() => {})
                }
              />
            </>
          )}
        </div>
      </div>
      <div className="writing-column">
        <textarea
          ref={titleRef}
          className="note-title"
          aria-label="Note title"
          rows={1}
          placeholder="Untitled"
          maxLength={500}
          value={title}
          readOnly={!!note.deletedAt}
          onChange={(event) => {
            setTitle(event.target.value);
            queue.edit({ title: event.target.value });
          }}
        />
        {!note.deletedAt && (
          <div
            className="format-bar"
            role="toolbar"
            aria-label="Text formatting"
          >
            <select
              aria-label="Text style"
              value={marks?.heading ?? 0}
              disabled={pasting}
              onChange={(event) => {
                const level = Number(event.target.value);
                if (level) editor.chain().focus().setHeading({ level }).run();
                else editor.chain().focus().setParagraph().run();
              }}
            >
              <option value="0">Text</option>
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  Heading {level}
                </option>
              ))}
            </select>
            {tools.map(([label, Icon, mark, action]) => (
              <Tool
                key={label}
                label={label}
                icon={Icon}
                active={!!marks?.[mark]}
                disabled={!editor || pasting}
                onClick={action}
              />
            ))}
            <select
              aria-label="Rewrite selection"
              className="rewrite-picker"
              value=""
              disabled={!editor || pasting || rewriting}
              onChange={(event) => {
                const style = event.target.value;
                event.target.value = "";
                if (style) rewrite(style);
              }}
            >
              <option value="">Rewrite</option>
              <option value="proofread">Proofread</option>
              <option value="tidy">Make clearer</option>
              <option value="shorten">Shorten</option>
            </select>
            <span className="toolbar-space" />
            <input className="attachment-input" ref={fileRef} type="file" multiple aria-label="Choose attachments" tabIndex={-1}
              onChange={(event) => { attachFiles(event.target.files); event.target.value = ""; }} />
            <Tool label="Attach files" icon={Paperclip} disabled={!editor || pasting || rewriting}
              onClick={() => fileRef.current?.click()} />
            <Tool
              label="Undo"
              icon={Undo2}
              disabled={!marks?.undo || pasting}
              onClick={() => editor.chain().focus().undo().run()}
            />
            <Tool
              label="Redo"
              icon={Redo2}
              disabled={!marks?.redo || pasting}
              onClick={() => editor.chain().focus().redo().run()}
            />
          </div>
        )}
        {warnings.length > 0 && (
          <details className="import-warning">
            <summary>Import details ({warnings.length})</summary>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
        {error && (
          <>
            <ErrorMessage
              error={error}
              retry={() => queue.flush().catch(() => {})}
            />
            <div className="recovery-actions">
              <button
                onClick={() =>
                  exportNote(null, { title, content: editor.getJSON(), noteId: note.id })
                }
              >
                <Download size={16} />
                Export recovery copy
              </button>
              <button onClick={() => setDiscardOpen(true)}>
                <RotateCcw size={16} />
                Reload saved note
              </button>
            </div>
          </>
        )}
        <EditorContent editor={editor} />
        <div className="note-status" role="status">
          {pasting || rewriting || status === "Saving..." ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <Check size={13} />
          )}
          {pasting
            ? "Adding content on this Mac..."
            : rewriting
              ? "Rewriting on this Mac..."
              : note.deletedAt
                ? "In Trash"
                : status}
        </div>
        {open && targets.length > 0 && suggestion?.coords && (
          <LinkSuggestions
            items={targets}
            highlight={highlight}
            coords={suggestion.coords}
            choose={choose}
          />
        )}
        <LinkPanel
          note={note}
          version={linkVersion}
          openNote={openNote}
          openLink={openLink}
          openPerson={openPerson}
        />
      </div>
      {linkOpen && (
        <LinkDialog editor={editor} close={() => setLinkOpen(false)} />
      )}
      {discardOpen && (
        <DiscardDialog
          close={() => setDiscardOpen(false)}
          reload={() => reloadNote(note).catch(() => setDiscardOpen(false))}
        />
      )}
    </article>
  );
}

// Open pages are tabs. The editor is only ever mounted for the active one — the
// others are a title and an id — so ten open pages cost ten titles, not ten
// autosaving editors, and switching flushes the one you were typing in first.
const MAX_TABS = 9;
const PAGES_HIDDEN_KEY = "focusbae.pagesHidden";
const readPagesHidden = () => {
  try {
    return localStorage.getItem(PAGES_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};
const tabKey = (kind, id) => `${kind}:${id}`;
const GRAPH_KEY = "graph:graph";

export function Notebook({
  workspace,
  today,
  refreshKey,
  flushRef,
  initialNoteId,
  noteOpened,
  openPerson,
  // The open pages outlive this component: leaving Notes for Actions and coming
  // back should find the same strip, so the shell holds it.
  tabs,
  setTabs,
  activeKey,
  setActiveKey,
}) {
  const [listing, setListing] = useState({ items: [], total: 0 });
  const [payload, setPayload] = useState(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState("meaning");
  const [view, setView] = useState("all");
  // null shows every note; "unfiled" shows the ones in no folder; otherwise a folder id.
  const [folderId, setFolderId] = useState(null);
  const [folders, setFolders] = useState({ items: [], unfiled: 0 });
  const [folderDialog, setFolderDialog] = useState(null);
  // Hiding the page list leaves only the writing column. It only applies while a
  // page is open, so the list can never disappear with nothing to write in.
  const [pagesHidden, setPagesHidden] = useState(readPagesHidden);
  const togglePages = () =>
    setPagesHidden((hidden) => {
      try {
        localStorage.setItem(PAGES_HIDDEN_KEY, hidden ? "0" : "1");
      } catch {}
      return !hidden;
    });
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const editorFlush = useRef(null);
  const operation = useRef(null);
  const alive = useRef(true);
  const payloadRef = useRef(null);
  payloadRef.current = payload;
  const activeRef = useRef(null);
  activeRef.current = activeKey;
  const refresh = () => setVersion((value) => value + 1);
  const act = (fn, skipSave = false) => {
    if (operation.current) return operation.current;
    setBusy(true);
    setError(null);
    setNotice("");
    const task = (async () => {
      if (!skipSave) await editorFlush.current?.();
      return fn();
    })();
    operation.current = task;
    task
      .catch((failure) => {
        if (alive.current) setError(failure);
      })
      .finally(() => {
        operation.current = null;
        if (alive.current) setBusy(false);
      });
    return task;
  };
  // Adds the tab or brings it forward, keeping its place in the strip. When the
  // strip is full the oldest page you are not looking at closes.
  const place = (tab) => {
    setTabs((old) => {
      const index = old.findIndex((item) => item.key === tab.key);
      if (index >= 0)
        return old.map((item, at) => (at === index ? { ...item, ...tab } : item));
      const next = [...old, tab];
      if (next.length <= MAX_TABS) return next;
      const drop = next.findIndex(
        (item) => item.key !== tab.key && item.key !== activeRef.current,
      );
      return drop < 0 ? next.slice(1) : next.filter((_, at) => at !== drop);
    });
    setActiveKey(tab.key);
  };
  const showNote = (note) => {
    setPayload({ kind: "note", note });
    if (!today)
      place({
        key: tabKey("note", note.id),
        kind: "note",
        id: note.id,
        title: note.title,
        deleted: !!note.deletedAt,
      });
  };
  useEffect(() => {
    alive.current = true;
    const flush = async () => {
      await operation.current;
      await editorFlush.current?.();
    };
    flushRef.current = flush;
    return () => {
      alive.current = false;
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef]);
  const loadNote = (id, includeDeleted = false) =>
    unwrap(api.notes.get({ workspaceId: workspace.id, id, includeDeleted }));
  const openNote = (id, includeDeleted = false) =>
    act(async () => {
      const note = await loadNote(id, includeDeleted);
      if (alive.current) showNote(note);
    }).catch(() => {});
  // Following a [[link]]. An unresolved one creates the page it names, which is how
  // a linked notebook grows: you write the link first and fill the page later.
  const openLink = (label) =>
    act(async () => {
      const target = await unwrap(
        api.links.resolve({ workspaceId: workspace.id, label }),
      );
      if (target.kind === "person" && target.id) {
        openPerson?.(target.id);
        return;
      }
      const note = target.id
        ? await loadNote(target.id)
        : await unwrap(
            api.notes.create({
              context: context(workspace.id),
              note: { title: label, content: emptyDoc },
            }),
          );
      if (!alive.current) return;
      showNote(note);
      if (!target.id) {
        refresh();
        setNotice(`Created "${label}".`);
      }
    }).catch(() => {});
  // One graph tab, with or without a page at its centre: opening the whole graph
  // and opening one page's connections should not leave two of them behind.
  const openGraph = (focus = null) =>
    act(async () => {
      const graph = await unwrap(api.links.graph({ workspaceId: workspace.id }));
      if (!alive.current) return;
      setPayload({ kind: "graph", graph, focusId: focus?.id ?? null });
      place({
        key: GRAPH_KEY,
        kind: "graph",
        id: "graph",
        focusId: focus?.id ?? null,
        title: focus ? `Graph · ${focus.title || "Untitled"}` : "Graph",
      });
    }).catch(() => {});
  const openSource = (kind, id) =>
    act(async () => {
      const source = await unwrap(
        api.search.source({ workspaceId: workspace.id, kind, id }),
      );
      if (!alive.current) return;
      setPayload({ kind: "source", source });
      place({
        key: tabKey(kind, id),
        kind: "source",
        sourceKind: kind,
        id,
        title: source.title,
      });
    }).catch(() => {});
  const reopen = (tab) => {
    if (tab.kind === "graph")
      return openGraph(
        tab.focusId
          ? { id: tab.focusId, title: tab.title.replace(/^Graph · /, "") }
          : null,
      );
    if (tab.kind === "source") return openSource(tab.sourceKind, tab.id);
    return openNote(tab.id, tab.deleted);
  };
  const selectTab = (tab) => (tab.key === activeKey ? undefined : reopen(tab));
  // Closing the page you are looking at moves to its neighbour — the one to the
  // right, or the one to the left when it was last in the strip.
  const closeTab = (key) =>
    act(async () => {
      const at = tabs.findIndex((tab) => tab.key === key);
      const remaining = tabs.filter((tab) => tab.key !== key);
      setTabs(remaining);
      if (key !== activeRef.current) return;
      const next = remaining[Math.min(at, remaining.length - 1)];
      setActiveKey(next?.key ?? null);
      setPayload(null);
      if (!next) return;
      if (next.kind !== "note") return reopen(next);
      const note = await loadNote(next.id, next.deleted);
      if (alive.current) setPayload({ kind: "note", note });
    }).catch(() => {});
  useEffect(() => {
    // Arriving with a note to open (from a recording, say) wins once; after that
    // the strip decides, so coming back to Notes returns you where you were.
    if (!today && initialNoteId && activeKey !== tabKey("note", initialNoteId)) {
      openNote(initialNoteId).then(() => noteOpened?.());
    } else if (!today && activeKey) {
      const current = tabs.find((tab) => tab.key === activeKey);
      if (current) reopen(current);
    }
    if (today)
      act(async () => {
        const note = await unwrap(
          api.notes.daily({ context: context(workspace.id) }),
        );
        if (alive.current) showNote(note);
      }).catch(() => {});
  }, [today, workspace.id, initialNoteId]);
  useEffect(() => {
    if (!today) return;
    const checkDate = () => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en", {
          timeZone: workspace.preferences.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date())
          .map(({ type, value }) => [type, value]),
      );
      const open = payloadRef.current?.note;
      if (
        open &&
        open.dailyDate !== `${parts.year}-${parts.month}-${parts.day}`
      )
        act(async () =>
          showNote(
            await unwrap(api.notes.daily({ context: context(workspace.id) })),
          ),
        ).catch(() => {});
    };
    const timer = setInterval(checkDate, 60000);
    window.addEventListener("focus", checkDate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkDate);
    };
  }, [today, workspace.id, workspace.preferences.timezone]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    const timer = setTimeout(
      () => {
        const request = query.trim()
          ? api.search[searchMode === "meaning" ? "hybrid" : "query"]({
              workspaceId: workspace.id,
              query: query.trim(),
            })
          : api.notes.browse({
              workspaceId: workspace.id,
              view,
              offset,
              limit: 40,
              ...(folderId ? { folderId } : {}),
            });
        unwrap(request)
          .then((result) => {
            if (current) {
              setListing(
                Array.isArray(result)
                  ? {
                      items: result.map((item) => ({
                        ...item,
                        preview: item.body,
                      })),
                      total: result.length,
                    }
                  : {
                      ...result,
                      // The page list carries its own preview; hybrid search
                      // results carry their text as body.
                      items: result.items.map((item) => ({
                        ...item,
                        preview: item.preview ?? item.body,
                      })),
                    },
              );
              setLoading(false);
            }
          })
          .catch((failure) => {
            if (current) {
              setError(failure);
              setLoading(false);
            }
          });
      },
      query ? 180 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [workspace.id, query, searchMode, view, folderId, offset, version, refreshKey]);
  // The folder list is small and changes rarely; it follows the same refresh
  // signal as the note list so a move shows up in both.
  useEffect(() => {
    let current = true;
    unwrap(api.folders.list({ workspaceId: workspace.id }))
      .then((result) => {
        if (!current) return;
        setFolders(result);
        // A folder deleted elsewhere must not leave the list filtering on nothing.
        setFolderId((open) =>
          open && open !== "unfiled" && !result.items.some((item) => item.id === open)
            ? null
            : open,
        );
      })
      .catch(() => current && setFolders({ items: [], unfiled: 0 }));
    return () => {
      current = false;
    };
  }, [workspace.id, version, refreshKey]);
  const selectedFolder =
    folderId && folderId !== "unfiled"
      ? folders.items.find((item) => item.id === folderId)
      : null;
  const createFolder = (name) =>
    act(async () => {
      const folder = await unwrap(
        api.folders.create({
          context: context(workspace.id),
          folder: { name, parentId: selectedFolder?.id ?? null },
        }),
      );
      setFolderId(folder.id);
      setOffset(0);
      refresh();
    }).catch(() => {});
  const renameFolder = (name) =>
    act(async () => {
      await unwrap(
        api.folders.update({
          context: context(workspace.id, selectedFolder.revision),
          id: selectedFolder.id,
          changes: { name },
        }),
      );
      refresh();
    }).catch(() => {});
  const removeFolder = () => {
    act(async () => {
      const result = await unwrap(
        api.folders.delete({
          context: context(workspace.id, selectedFolder.revision),
          id: selectedFolder.id,
        }),
      );
      setFolderId(result.movedTo ?? null);
      setOffset(0);
      refresh();
      setNotice(
        result.notes || result.folders
          ? `Folder removed. ${[
              result.notes && `${result.notes} ${result.notes === 1 ? "page" : "pages"}`,
              result.folders &&
                `${result.folders} ${result.folders === 1 ? "folder" : "folders"}`,
            ]
              .filter(Boolean)
              .join(" and ")} moved ${result.movedTo ? "up one level" : "out of any folder"}.`
          : "Folder removed.",
      );
    }).catch(() => {});
  };
  const moveNote = (note, target) =>
    act(async () => {
      const saved = await unwrap(
        api.notes.move({
          context: context(workspace.id, note.revision),
          id: note.id,
          folderId: target,
        }),
      );
      setPayload({ kind: "note", note: saved });
      refresh();
    }).catch(() => {});
  const open = (item) =>
    query && ["transcript", "action"].includes(item.kind)
      ? openSource(item.kind, item.id)
      : openNote(item.id, view === "trash" && !query);
  const exportNote = (note, draft) =>
    act(async () => {
      const result = await unwrap(
        api.documents.export({
          workspaceId: workspace.id,
          ...(note ? { ids: [note.id] } : {}),
          ...(draft ? { draft } : {}),
        }),
      );
      if (!result.canceled)
        setNotice(
          `Exported ${result.count} ${result.count === 1 ? "note" : "notes"} to ${result.folderName}.`,
        );
    }, !!draft).catch(() => {});
  // Reads the page and proposes what it promises. The editor is flushed first by
  // act(), so what is read is what you can see.
  // Not run through act(): the on-device model can take a minute, and the notebook
  // must stay usable meanwhile. Only this button waits.
  const [finding, setFinding] = useState(null);
  const findCommitments = async (note) => {
    if (finding) return;
    setFinding(note.id);
    setError(null);
    setNotice("Finding commitments on this page. You can keep writing.");
    try {
      await editorFlush.current?.();
      const result = await unwrap(
        api.notes.findCommitments({ workspaceId: workspace.id, id: note.id }),
      );
      if (!alive.current) return;
      refresh();
      setNotice(
        result.proposed
          ? `${result.proposed} ${result.proposed === 1 ? "commitment" : "commitments"} proposed from this page. Accept or reject them in Actions.`
          : result.read
            ? "Nothing new here — every commitment on this page has already been proposed."
            : "No commitments found on this page.",
      );
    } catch (failure) {
      if (alive.current) {
        setNotice("");
        setError(failure);
      }
    } finally {
      if (alive.current) setFinding(null);
    }
  };
  const changeDeletion = (method, note) =>
    act(async () => {
      const result = await unwrap(
        api.notes[method]({
          context: context(workspace.id, note.revision),
          id: note.id,
        }),
      );
      if (result.canceled) return;
      setTabs((old) => old.filter((tab) => tab.key !== tabKey("note", note.id)));
      setActiveKey(null);
      setPayload(null);
      refresh();
      setNotice(method === "purge" ? "Note and attachments permanently deleted. Previous backups and exports are unchanged." : method === "delete" ? "Moved to Trash." : "Note restored.");
    }).catch(() => {});
  const selectedNoteId = payload?.kind === "note" ? payload.note.id : null;
  return (
    <div
      className={`notebook ${today ? "daily-notebook" : ""} ${payload ? "has-selection" : ""} ${pagesHidden && !today ? "pages-hidden" : ""}`}
      aria-busy={busy}
    >
      {!today && (
        <section className="note-library" aria-label="Note library">
          <div className="library-heading">
            <h2>Your pages</h2>
            <Tool
              label="Workspace graph"
              icon={Network}
              disabled={busy}
              onClick={() => openGraph()}
            />
            <Tool
              label="New note"
              icon={Plus}
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const note = await unwrap(
                    api.notes.create({
                      context: context(workspace.id),
                      note: {
                        title: "",
                        content: emptyDoc,
                        ...(selectedFolder ? { folderId: selectedFolder.id } : {}),
                      },
                    }),
                  );
                  showNote(note);
                  setView("all");
                  setQuery("");
                  setOffset(0);
                  refresh();
                }).catch(() => {})
              }
            />
          </div>
          <div className="note-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search workspace"
              placeholder="Search"
              maxLength={1000}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div className="library-filters">
            {query ? (
              <select
                aria-label="Search mode"
                value={searchMode}
                onChange={(event) => setSearchMode(event.target.value)}
              >
                <option value="meaning">Meaning + words</option>
                <option value="words">Exact words</option>
              </select>
            ) : (
              <select
                aria-label="Note view"
                value={folderId ? `folder:${folderId}` : view}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("folder:")) {
                    setFolderId(value.slice(7));
                    setView("all");
                  } else {
                    setFolderId(null);
                    setView(value);
                  }
                  setOffset(0);
                }}
              >
                <option value="all">All notes</option>
                <option value="pinned">Pinned</option>
                {folders.items.length > 0 && (
                  <optgroup label="Folders">
                    {folders.items.map((folder) => (
                      <option key={folder.id} value={`folder:${folder.id}`}>
                        {folder.path}
                      </option>
                    ))}
                    <option value="folder:unfiled">No folder</option>
                  </optgroup>
                )}
                <option value="trash">Trash</option>
              </select>
            )}
            {!query && (
              <span className="library-folder-tools">
                {selectedFolder ? (
                  <FolderMenu
                    folder={selectedFolder}
                    busy={busy}
                    create={() => setFolderDialog({ mode: "create" })}
                    rename={() =>
                      setFolderDialog({ mode: "rename", folder: selectedFolder })
                    }
                    remove={removeFolder}
                  />
                ) : (
                  <Tool
                    label="New folder"
                    icon={FolderPlus}
                    disabled={busy}
                    onClick={() => setFolderDialog({ mode: "create" })}
                  />
                )}
              </span>
            )}
            <span className="library-count">
              {loading
                ? "..."
                : `${listing.mode === "lexical-fallback" ? "Words only · " : ""}${listing.total}${query && listing.total === 100 ? "+" : ""}`}
            </span>
          </div>
          <div className="note-rows">
            {loading ? (
              <p className="library-empty" role="status">
                Loading...
              </p>
            ) : !listing.items.length ? (
              <p className="library-empty">
                {query
                  ? "No matches"
                  : view === "trash"
                    ? "Trash is empty"
                    : view === "pinned"
                      ? "No pinned notes"
                      : "No notes yet"}
              </p>
            ) : (
              listing.items.map((item) => (
                <button
                  className="note-row"
                  key={`${item.kind}:${item.id}`}
                  disabled={busy}
                  aria-current={selectedNoteId === item.id ? "true" : undefined}
                  onClick={() => open(item)}
                >
                  <span className="note-row-title">
                    {item.pinned && <Pin size={12} />}
                    {item.title || "Untitled"}
                  </span>
                  <span className="note-row-preview">
                    {item.preview || "Empty page"}
                  </span>
                  <span className="note-row-date">
                    {["transcript", "action"].includes(item.kind)
                      ? item.kind
                      : item.updatedAt
                        ? new Intl.DateTimeFormat("en", {
                            dateStyle: "medium",
                            timeZone: workspace.preferences.timezone,
                          }).format(new Date(item.updatedAt))
                        : "Note"}
                  </span>
                </button>
              ))
            )}
          </div>
          {!query && listing.total > 40 && (
            <div className="pagination">
              <Tool
                label="Previous notes"
                icon={ChevronLeft}
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 40))}
              />
              <span>{offset / 40 + 1}</span>
              <Tool
                label="Next notes"
                icon={ChevronRight}
                disabled={offset + 40 >= listing.total}
                onClick={() => setOffset(offset + 40)}
              />
            </div>
          )}
          <div className="library-footer">
            <Tool
              label="Import notes"
              icon={Upload}
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const result = await unwrap(
                    api.documents.import({ workspaceId: workspace.id }),
                  );
                  if (result.canceled) return;
                  refresh();
                  if (result.items[0]) {
                    showNote(result.items[0]);
                    setView("all");
                    setQuery("");
                  }
                  setNotice(
                    `Imported ${result.items.length} ${result.items.length === 1 ? "note" : "notes"}.${result.failures.map((failure) => ` ${failure.name}: ${failure.message}`).join("")}`,
                  );
                }).catch(() => {})
              }
            />
            <Tool
              label="Export all notes"
              icon={Download}
              disabled={busy}
              onClick={() => exportNote(null)}
            />
            <span>On this Mac</span>
          </div>
        </section>
      )}
      <div className="notebook-detail" inert={busy}>
        {!today && tabs.length > 0 && (
          <div className="note-tabs" role="tablist" aria-label="Open pages">
            {tabs.map((tab) => (
              <span
                key={tab.key}
                className={`note-tab ${tab.key === activeKey ? "active" : ""}`}
              >
                <button
                  role="tab"
                  aria-selected={tab.key === activeKey}
                  disabled={busy}
                  onClick={() => selectTab(tab)}
                >
                  {tab.kind === "graph" ? (
                    <Network size={12} />
                  ) : tab.kind === "source" ? (
                    <FileText size={12} />
                  ) : null}
                  {tab.title || "Untitled"}
                </button>
                <button
                  className="note-tab-close"
                  aria-label={`Close ${tab.title || "Untitled"}`}
                  disabled={busy}
                  onClick={() => closeTab(tab.key)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {error && (
          <ErrorMessage
            error={error}
            retry={() => {
              setError(null);
              refresh();
              if (today && !payload)
                act(async () =>
                  showNote(
                    await unwrap(
                      api.notes.daily({ context: context(workspace.id) }),
                    ),
                  ),
                ).catch(() => {});
            }}
          />
        )}
        {folderDialog && (
          <FolderDialog
            mode={folderDialog.mode}
            folder={folderDialog.folder}
            parentPath={folderDialog.mode === "create" ? selectedFolder?.path : null}
            close={() => setFolderDialog(null)}
            submit={folderDialog.mode === "rename" ? renameFolder : createFolder}
          />
        )}
        {notice && (
          <div className="notebook-notice" role="status">
            <span>{notice}</span>
            <Tool
              label="Dismiss notification"
              icon={X}
              onClick={() => setNotice("")}
            />
          </div>
        )}
        {payload?.kind === "graph" ? (
          <GraphView
            graph={payload.graph}
            focusId={payload.focusId}
            open={(node) => {
              if (node.kind === "note") return openNote(node.id);
              if (node.kind === "person") return openPerson?.(node.id);
              setNotice(
                node.kind === "recording"
                  ? "Open Recordings to play that conversation."
                  : "Open Actions to work on that one.",
              );
            }}
          />
        ) : payload?.kind === "source" ? (
          <section className="source-page">
            {!today && (
              <Tool
                label="Back to notes"
                icon={ArrowLeft}
                onClick={() =>
                  act(() => {
                    setPayload(null);
                    setActiveKey(null);
                  }).catch(() => {})
                }
              />
            )}
            <span className="muted">
              {payload.source.kind}
              {payload.source.startMs !== undefined
                ? ` · ${Math.floor(payload.source.startMs / 60000)}:${String(Math.floor(payload.source.startMs / 1000) % 60).padStart(2, "0")}`
                : ""}
            </span>
            <h2>{payload.source.title}</h2>
            <p>{payload.source.text}</p>
          </section>
        ) : payload?.kind === "note" ? (
          <NoteEditor
            key={`${payload.note.id}:${editorVersion}`}
            note={payload.note}
            folders={folders.items}
            moveNote={moveNote}
            pagesHidden={pagesHidden}
            togglePages={today ? null : togglePages}
            flushRef={editorFlush}
            changed={(note) => {
              setPayload({ kind: "note", note });
              setTabs((old) =>
                old.map((tab) =>
                  tab.key === tabKey("note", note.id)
                    ? { ...tab, title: note.title }
                    : tab,
                ),
              );
              refresh();
            }}
            remove={(note) => changeDeletion("delete", note)}
            restore={(note) => changeDeletion("restore", note)}
            purge={(note) => changeDeletion("purge", note)}
            exportNote={exportNote}
            findCommitments={findCommitments}
            finding={finding === payload.note.id}
            showConnections={(note) => openGraph(note)}
            openNote={openNote}
            openLink={openLink}
            openPerson={openPerson}
            reloadNote={(note) =>
              act(async () => {
                const saved = await loadNote(note.id);
                setPayload({ kind: "note", note: saved });
                setEditorVersion((value) => value + 1);
              }, true)
            }
            showBack={!today}
            back={() =>
              act(() => {
                setPayload(null);
                setActiveKey(null);
              }).catch(() => {})
            }
          />
        ) : (
          <div className="blank-page">
            <FileText size={24} strokeWidth={1.2} />
            <p>
              {today
                ? busy
                  ? "Opening today..."
                  : "No page open"
                : "Your notebook"}
            </p>
            {today && !busy && (
              <button
                onClick={() =>
                  act(async () =>
                    showNote(
                      await unwrap(
                        api.notes.daily({ context: context(workspace.id) }),
                      ),
                    ),
                  ).catch(() => {})
                }
              >
                <Plus size={16} />
                New daily note
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
