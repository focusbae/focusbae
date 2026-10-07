import { Node } from "@tiptap/core";

function unwrap(result) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export const NoteAttachment = Node.create({
  name: "noteAttachment",
  group: "block",
  atom: true,
  draggable: true,
  addOptions() { return { workspaceId: null, noteId: null }; },
  addAttributes() { return { id: { default: null } }; },
  // Only canonical JSON can introduce an attachment reference. Pasted HTML is
  // deliberately not an authority to attach files from another note.
  renderHTML({ node }) { return ["div", { "data-note-attachment": node.attrs.id }, "Attachment"]; },
  addNodeView() {
    const { workspaceId, noteId } = this.options;
    return ({ node }) => {
      let alive = true;
      const dom = document.createElement("figure");
      dom.className = "note-attachment";
      dom.contentEditable = "false";
      dom.dataset.attachmentId = node.attrs.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attachment-card";
      button.textContent = "Loading attachment…";
      button.disabled = true;
      const scope = { workspaceId, noteId, id: node.attrs.id };
      dom.append(button);
      const failure = (error) => {
        if (!alive) return;
        button.textContent = error.message;
        button.setAttribute("aria-label", "Attachment unavailable");
      };
      window.focusbaeWorkspace.attachments.info(scope).then(unwrap).then((item) => {
        if (!alive) return;
        button.disabled = false;
        button.setAttribute("aria-label", `Open ${item.displayName} in Quick Look`);
        const label = document.createElement("strong");
        label.textContent = item.displayName;
        const detail = document.createElement("span");
        const size = item.byteSize < 1024 ? `${item.byteSize} B` : item.byteSize < 1024 * 1024
          ? `${(item.byteSize / 1024).toFixed(1)} KB` : `${(item.byteSize / 1024 / 1024).toFixed(1)} MB`;
        const extension = item.displayName.split(".").at(-1);
        const type = extension && extension !== item.displayName && extension.length <= 10 ? extension.toUpperCase() : "File";
        detail.textContent = `${type} · ${size} · Quick Look`;
        button.replaceChildren(label, detail);
        if (item.imageUrl) {
          const image = document.createElement("img");
          image.src = item.imageUrl;
          image.alt = item.displayName;
          image.draggable = false;
          image.addEventListener("error", () => {
            image.remove();
            detail.textContent += " · Preview unavailable";
          });
          dom.prepend(image);
          dom.classList.add("attachment-image");
        }
      }).catch(failure);
      button.addEventListener("click", () => window.focusbaeWorkspace.attachments.open(scope).then(unwrap).catch(failure));
      return { dom, stopEvent: (event) => event.target.closest("button") !== null,
        ignoreMutation: () => true, destroy: () => { alive = false; } };
    };
  },
});

export async function uploadAttachment(file, workspaceId, noteId) {
  if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} is larger than 100 MB. Choose a smaller file.`);
  const api = window.focusbaeWorkspace.attachments;
  const { token } = unwrap(await api.begin({ workspaceId, noteId, displayName: file.name || "Pasted image.png", byteSize: file.size }));
  const scope = { workspaceId, token };
  try {
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192)
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      unwrap(await api.chunk({ ...scope, offset, data: btoa(binary) }));
    }
    return unwrap(await api.finish(scope));
  } catch (error) {
    await api.cancel(scope).catch(() => {});
    throw error;
  }
}
