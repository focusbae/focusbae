"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const sanitizeHtml = require("sanitize-html");
const { parseDocument } = require("htmlparser2");
const MarkdownIt = require("markdown-it");
const links = require("./links");
const v = require("./validation");
const files = require("./files");
const { check } = require("./errors");
const { documentContent, attachmentIds, EMPTY_DOCUMENT } = require("./content");
const { MAX_BYTES } = require("./attachments");
// A 2 MiB canonical document plus its portable envelope must round-trip.
const MAX_IMPORT = 3 * 1024 * 1024;
const TAGS = [
  "p",
  "div",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "u",
  "a",
];
const MARKS = {
  b: "bold",
  strong: "bold",
  em: "italic",
  i: "italic",
  s: "strike",
  del: "strike",
  u: "underline",
  code: "code",
};
const paragraph = (content = []) => ({
  type: "paragraph",
  ...(content.length ? { content } : {}),
});
function safeHref(href) {
  try {
    const url = new URL(href);
    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function htmlDocument(html) {
  const warnings = new Set();
  let count = 0;
  const inspect = (nodes, depth = 0) => {
    check(
      depth <= 32 && (count += nodes.length) <= 50000,
      "INVALID_INPUT",
      "Document is too complex",
    );
    for (const node of nodes) {
      if (
        node.name &&
        ![...TAGS, "html", "head", "body", "meta", "title"].includes(node.name)
      )
        warnings.add("Unsupported elements were simplified or removed.");
      if (
        node.attribs &&
        Object.keys(node.attribs).some(
          (name) => !["href", "start"].includes(name),
        )
      )
        warnings.add("Styling and unsupported attributes were removed.");
      if (node.name === "a" && !safeHref(node.attribs?.href))
        warnings.add("Unsafe or relative links were removed.");
      if (node.children) inspect(node.children, depth + 1);
    }
  };
  inspect(parseDocument(html).children);
  const clean = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: { a: ["href"], ol: ["start"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "head",
      "iframe",
      "object",
      "svg",
      "math",
    ],
  });
  function inline(nodes, marks = []) {
    return nodes.flatMap((node) => {
      if (node.type === "text")
        return node.data
          ? [
              {
                type: "text",
                text: node.data,
                ...(marks.length ? { marks } : {}),
              },
            ]
          : [];
      if (node.name === "br") return [{ type: "hardBreak" }];
      let extra = MARKS[node.name] ? { type: MARKS[node.name] } : null;
      if (node.name === "a" && safeHref(node.attribs?.href))
        extra = { type: "link", attrs: { href: node.attribs.href } };
      return inline(
        node.children ?? [],
        extra
          ? [...marks.filter((mark) => mark.type !== extra.type), extra]
          : marks,
      );
    });
  }
  function blocks(nodes) {
    const result = [];
    let pending = [];
    const flush = () => {
      if (pending.some((node) => node.type !== "text" || node.text.trim()))
        result.push(paragraph(pending));
      pending = [];
    };
    for (const node of nodes) {
      const tag = node.name;
      if (
        [
          "p",
          "div",
          "blockquote",
          "ul",
          "ol",
          "li",
          "pre",
          "hr",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
        ].includes(tag)
      ) {
        flush();
        if (tag === "hr") result.push({ type: "horizontalRule" });
        else if (tag === "pre") {
          const text = inline(node.children ?? [])
            .map((item) => item.text ?? "\n")
            .join("");
          result.push({
            type: "codeBlock",
            ...(text ? { content: [{ type: "text", text }] } : {}),
          });
        } else if (tag === "ul" || tag === "ol") {
          const content = (node.children ?? [])
            .filter((item) => item.name === "li")
            .map((item) => {
              const children = blocks(item.children ?? []);
              if (children[0]?.type !== "paragraph")
                children.unshift(paragraph());
              return { type: "listItem", content: children };
            });
          if (content.length)
            result.push({
              type: tag === "ul" ? "bulletList" : "orderedList",
              ...(tag === "ol"
                ? {
                    attrs: {
                      start: Math.min(
                        1000000,
                        Math.max(1, parseInt(node.attribs?.start, 10) || 1),
                      ),
                    },
                  }
                : {}),
              content,
            });
        } else if (tag === "blockquote")
          result.push({
            type: "blockquote",
            content: blocks(node.children ?? []),
          });
        else if (tag === "div" || tag === "li")
          result.push(...blocks(node.children ?? []));
        else {
          const content = inline(node.children ?? []);
          result.push({
            type: /^h[1-6]$/.test(tag) ? "heading" : "paragraph",
            ...(/^h/.test(tag) ? { attrs: { level: Number(tag[1]) } } : {}),
            ...(content.length ? { content } : {}),
          });
        }
      } else pending.push(...inline([node]));
    }
    flush();
    return result.length ? result : [paragraph()];
  }
  return {
    content: documentContent({
      type: "doc",
      content: blocks(parseDocument(clean).children),
    }).content,
    warnings: [...warnings],
  };
}
function parseImport(name, bytes) {
  check(
    Buffer.isBuffer(bytes) && bytes.length <= MAX_IMPORT,
    "INVALID_INPUT",
    "Import exceeds 3 MiB",
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    check(false, "INVALID_INPUT", "Import must be UTF-8");
  }
  check(!text.includes("\0"), "INVALID_INPUT", "Binary import is unsupported");
  const extension = path.extname(name).toLowerCase();
  const title = path.basename(name, extension).slice(0, 500);
  if (extension === ".json") {
    const value = JSON.parse(text);
    v.object(value, ["format", "version", "note", "attachments"]);
    check(
      value.format === "focusbae-note" && [1, 2].includes(value.version),
      "INVALID_INPUT",
      "Not a FocusBae note export",
    );
    v.object(value.note, [
      "title",
      "content",
      "contentSchemaVersion",
      "kind",
      "dailyDate",
      "timezone",
      "pinned",
    ]);
    v.text(value.note.title, "title", 500, true);
    return {
      title: value.note.title,
      content: documentContent(
        value.note.content,
        value.note.contentSchemaVersion,
      ).content,
      warnings: ["Imported as an independent note."],
      pinned: value.note.pinned === true,
      attachments: value.attachments ?? [],
    };
  }
  if (extension === ".txt")
    return {
      title,
      content: documentContent({
        type: "doc",
        content: text
          .split(/\r?\n/)
          .map((line) => paragraph(line ? [{ type: "text", text: line }] : [])),
      }).content,
      warnings: [],
    };
  check(
    [".md", ".markdown", ".html", ".htm"].includes(extension),
    "UNSUPPORTED_FORMAT",
    "Unsupported import format",
  );
  return {
    title,
    ...htmlDocument(
      [".md", ".markdown"].includes(extension)
        ? new MarkdownIt({ html: true, linkify: false }).render(text)
        : text,
    ),
  };
}
function readImport(file, limit = MAX_IMPORT) {
  check(path.isAbsolute(file), "INVALID_INPUT", "Expected a selected file");
  files.inspect(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(
      stat.isFile() && stat.nlink === 1 && stat.size <= limit,
      "INVALID_INPUT",
      "Invalid import file",
    );
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    let read;
    while (
      (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0
    )
      size += read;
    check(size === stat.size, "INVALID_INPUT", "Import changed while reading");
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}
function importFile(store, file) {
  const bytes = readImport(file);
  const name = path.basename(file);
  const parsed = parseImport(name, bytes);
  const attachments = parsed.attachments ?? [];
  check(Array.isArray(attachments) && attachments.length <= 10000, "INVALID_INPUT", "Too many attachments");
  const attachmentMap = new Map();
  const source = (item) => path.join(path.dirname(file), item.path);
  // Validate every sidecar before creating a note. Relative filenames are an
  // allowlist, not arbitrary paths from an imported JSON document.
  for (const item of attachments) {
    v.object(item, ["id", "displayName", "mediaType", "byteSize", "contentHash", "path", "previewId"]);
    v.uuid(item.id); v.text(item.displayName, "file name", 255); v.text(item.mediaType, "media type", 200);
    v.integer(item.byteSize, "file size", 0, MAX_BYTES);
    check(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.mediaType), "INVALID_INPUT", "Invalid media type");
    check(typeof item.path === "string" && /^attachments\/[0-9a-f-]{36}(?:\.[a-zA-Z0-9]{1,20})?$/.test(item.path) && /^[0-9a-f]{64}$/.test(item.contentHash), "INVALID_INPUT", "Invalid attachment reference");
    check(!attachmentMap.has(item.id), "INVALID_INPUT", "Duplicate attachment");
    check(files.inspect(path.join(path.dirname(file), "attachments"), true), "INVALID_INPUT", "Missing attachments folder");
    const data = readImport(source(item), MAX_BYTES);
    check(data.length === item.byteSize && v.hash(data) === item.contentHash, "ATTACHMENT_CORRUPT", "Damaged exported attachment");
    attachmentMap.set(item.id, item);
  }
  const used = new Set(attachmentIds(parsed.content));
  for (const id of used) check(attachmentMap.has(id), "INVALID_INPUT", "Missing exported attachment");
  for (const item of attachments) if (item.previewId) {
    v.uuid(item.previewId);
    check(attachmentMap.has(item.previewId) && item.previewId !== item.id && !attachmentMap.get(item.previewId).previewId, "INVALID_INPUT", "Invalid preview reference");
    check(attachmentMap.get(item.previewId).mediaType === "image/png", "INVALID_INPUT", "Invalid preview format");
    used.add(item.previewId);
  }
  check(attachments.every((item) => used.has(item.id)), "INVALID_INPUT", "Unreferenced attachment");
  const ctx = (revision) => ({
    workspaceId: store.identity.id,
    clientRequestId: randomUUID(),
    ...(revision ? { expectedRevision: revision } : {}),
  });
  // Keep the source independent until its note is durably committed. File journaling
  // handles interrupted preservation; the source selected by the user is never changed.
  const pendingWarning =
    "Original preservation is incomplete. Keep the source file.";
  let note = store.createNote(ctx(), {
    title: parsed.title,
    content: attachments.length ? EMPTY_DOCUMENT : parsed.content,
    metadata: {
      pinned: parsed.pinned ?? false,
      importWarnings: [...parsed.warnings, pendingWarning],
    },
  });
  if (attachments.length) {
    const ids = new Map();
    for (const item of attachments) {
      const data = readImport(source(item), MAX_BYTES);
      check(data.length === item.byteSize && v.hash(data) === item.contentHash, "ATTACHMENT_CORRUPT", "Attachment changed during import");
      ids.set(item.id, store.putAttachment(ctx(), { noteId: note.id, displayName: item.displayName, mediaType: item.mediaType }, data));
    }
    for (const item of attachments) if (item.previewId) {
      const record = ids.get(item.id);
      store.updateAttachment(ctx(record.revision), record.id, { previewId: ids.get(item.previewId).id });
    }
    const content = structuredClone(parsed.content);
    const remap = (node) => {
      if (node.type === "noteAttachment") node.attrs.id = ids.get(node.attrs.id).id;
      for (const child of node.content ?? []) remap(child);
    };
    remap(content);
    note = store.updateNote(ctx(note.revision), note.id, { content });
  }
  try {
    const attachment = store.putAttachment(
      ctx(),
      {
        noteId: note.id,
        displayName: name,
        mediaType: "application/octet-stream",
      },
      bytes,
    );
    note = store.updateNote(ctx(note.revision), note.id, {
      metadata: {
        ...note.metadata,
        importWarnings: parsed.warnings,
        originalAttachmentId: attachment.id,
      },
    });
  } catch {
    /* The already committed note carries a durable partial-import warning. */
  }
  return note;
}
function markdown(content, attachments = new Map()) {
  const special = (text) => text.replace(/[\\`*_{}\[\]<>#!|~]/g, "\\$&");
  // Wikilinks are written verbatim so an exported note is the same note in Obsidian;
  // everything around them is still escaped.
  const escape = (text) => {
    const pattern = new RegExp(links.LINK.source, "g");
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      result += special(text.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    return result + special(text.slice(cursor));
  };
  function inline(node) {
    if (node.type === "hardBreak") return "  \n";
    let result = escape(node.text ?? "");
    for (const mark of node.marks ?? []) {
      if (mark.type === "code") {
        const ticks = "`".repeat(
          Math.max(
            1,
            ...((node.text ?? "").match(/`+/g) ?? []).map(
              (run) => run.length + 1,
            ),
          ),
        );
        result = `${ticks} ${node.text} ${ticks}`;
      }
      if (mark.type === "bold") result = `**${result}**`;
      if (mark.type === "italic") result = `*${result}*`;
      if (mark.type === "strike") result = `~~${result}~~`;
      if (mark.type === "link")
        result = `[${result}](<${mark.attrs.href.replace(/[<>\r\n]/g, (char) => encodeURIComponent(char))}>)`;
    }
    return result;
  }
  function block(node) {
    if (node.type === "noteAttachment") {
      const item = attachments.get(node.attrs.id);
      check(item, "INVALID_INPUT", "Missing export attachment");
      const label = special(item.displayName.replace(/[\r\n]/g, " "));
      const preview = item.previewId ? attachments.get(item.previewId) : item;
      return preview.image ? `![${label}](${preview.path})${item.previewId ? `\n\n[Original ${label}](${item.path})` : ""}` : `[${label}](${item.path})`;
    }
    if (node.type === "doc" || node.type === "listItem")
      return (node.content ?? []).map(block).join("\n\n");
    if (node.type === "horizontalRule") return "---";
    if (node.type === "blockquote")
      return (node.content ?? [])
        .map(block)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    if (["orderedList", "bulletList"].includes(node.type))
      return (node.content ?? [])
        .map((item, index) => {
          const prefix =
            node.type === "bulletList"
              ? "- "
              : `${(node.attrs?.start ?? 1) + index}. `;
          return (
            prefix +
            block(item)
              .split("\n")
              .join(`\n${" ".repeat(prefix.length)}`)
          );
        })
        .join("\n");
    if (node.type === "codeBlock") {
      const text = (node.content ?? []).map((item) => item.text).join("");
      const fence = "`".repeat(
        Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)),
      );
      return `${fence}\n${text}\n${fence}`;
    }
    return `${node.type === "heading" ? "#".repeat(node.attrs.level) + " " : ""}${(node.content ?? []).map(inline).join("")}`;
  }
  return block(content) + "\n";
}
async function exportNotes(store, directory, ids, draft) {
  check(
    path.isAbsolute(directory) && files.inspect(directory, true),
    "INVALID_INPUT",
    "Select an export directory",
  );
  if (ids !== undefined) {
    check(
      Array.isArray(ids) && ids.length > 0 && ids.length <= 10000,
      "INVALID_INPUT",
      "Invalid note selection",
    );
    ids.forEach((id) => v.uuid(id));
  }
  const target = path.join(
    fs.realpathSync(directory),
    `FocusBae-notes-${randomUUID()}`,
  );
  fs.mkdirSync(target, { mode: 0o700 });
  const manifest = {
    format: "focusbae-notes",
    version: 1,
    workspaceId: store.identity.id,
    createdAt: new Date().toISOString(),
    complete: false,
    notes: [],
  };
  files.atomicJson(path.join(target, "manifest.json"), manifest);
  const ctx = { workspaceId: store.identity.id };
  const allIds = draft
    ? [randomUUID()]
    : ids
      ? [...new Set(ids)]
      : store._db
          .prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id",
          )
          .all()
          .map(({ id }) => id);
  for (const id of allIds) {
    const note = draft
      ? {
          ...draft,
          contentSchemaVersion: 1,
          kind: "note",
          dailyDate: null,
          timezone: store._timezone(),
          revision: null,
        }
      : store.get(ctx, "note", id);
    const structured = {
      format: "focusbae-note",
      version: 1,
      note: {
        title: note.title,
        content: note.content,
        contentSchemaVersion: note.contentSchemaVersion,
        kind: note.kind,
        dailyDate: note.dailyDate,
        timezone: note.timezone,
        pinned: note.metadata?.pinned === true,
      },
    };
    const attached = new Map();
    const ownerId = draft ? draft.noteId : note.id;
    const addAttachment = (attachmentId) => {
      if (attached.has(attachmentId)) return;
      const item = store.get(ctx, "attachment", attachmentId);
      check(item.noteId === ownerId, "SCOPE_MISMATCH", "Attachment belongs to another note");
      const bytes = store.readAttachment(ctx, attachmentId);
      const extension = path.extname(item.displayName).slice(1);
      const relative = `attachments/${item.id}${/^[a-zA-Z0-9]{1,20}$/.test(extension) ? `.${extension}` : ""}`;
      files.privateDirectory(path.join(target, "attachments"));
      if (!fs.existsSync(path.join(target, relative))) files.writeExclusive(path.join(target, relative), bytes);
      attached.set(item.id, { id: item.id, displayName: item.displayName, mediaType: item.mediaType, byteSize: item.byteSize,
        contentHash: item.contentHash, path: relative, ...(item.previewId ? { previewId: item.previewId } : {}),
        image: !!require("./note-attachments").imageType(bytes) });
      if (item.previewId) addAttachment(item.previewId);
    };
    attachmentIds(note.content).forEach(addAttachment);
    if (attached.size) {
      structured.version = 2;
      structured.attachments = [...attached.values()].map(({ image, ...item }) => item);
      files.flushDirectory(path.join(target, "attachments"));
    }
    const jsonBytes = Buffer.from(JSON.stringify(structured) + "\n");
    const mdBytes = Buffer.from(
      `# ${note.title.replace(/[\r\n]/g, " ").replace(/[\\`*_\[\]<>#]/g, "\\$&")}\n\n${markdown(note.content, attached)}`,
    );
    files.writeExclusive(path.join(target, `${id}.json`), jsonBytes);
    files.writeExclusive(path.join(target, `${id}.md`), mdBytes);
    const entry = {
      id,
      title: note.title,
      revision: note.revision,
      structured: `${id}.json`,
      markdown: `${id}.md`,
      structuredHash: v.hash(jsonBytes),
      markdownHash: v.hash(mdBytes),
    };
    if (note.metadata?.originalAttachmentId) {
      const bytes = store.readAttachment(
        ctx,
        note.metadata.originalAttachmentId,
      );
      const original = `${id}.original`;
      files.writeExclusive(path.join(target, original), bytes);
      entry.original = original;
      entry.originalHash = v.hash(bytes);
    }
    manifest.notes.push(entry);
    if (manifest.notes.length % 100 === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
  manifest.complete = true;
  files.atomicJson(path.join(target, "manifest.json"), manifest);
  files.flushDirectory(target);
  files.flushDirectory(directory);
  return { count: manifest.notes.length, folderName: path.basename(target) };
}
module.exports = {
  parseImport,
  htmlDocument,
  markdown,
  importFile,
  exportNotes,
  readImport,
  safeHref,
};
