// One queue belongs to one note. An ambiguous retry keeps the same request ID
// and expected revision; newer edits wait until that write is acknowledged.
export class SaveQueue {
  constructor({
    note,
    write,
    changed = () => {},
    delay = 400,
    uuid = () => crypto.randomUUID(),
  }) {
    Object.assign(this, { note, write, changed, delay, uuid });
    this.pending = {};
    this.flight = null;
    this.running = null;
    this.error = null;
  }
  get dirty() {
    return !!this.flight || Object.keys(this.pending).length > 0;
  }
  edit(changes) {
    this.pending = { ...this.pending, ...changes };
    clearTimeout(this.timer);
    this.changed("Unsaved", this.error);
    if (!this.error)
      this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.running) {
      await this.running;
      if (this.dirty) return this.flush();
      return this.note;
    }
    this.running = this.drain();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }
  async drain() {
    while (this.dirty) {
      if (!this.flight) {
        this.flight = {
          context: {
            workspaceId: this.note.workspaceId,
            clientRequestId: this.uuid(),
            expectedRevision: this.note.revision,
          },
          id: this.note.id,
          changes: this.pending,
        };
        this.pending = {};
      }
      this.changed("Saving...", null);
      try {
        this.note = await this.write(this.flight);
        this.flight = null;
        this.error = null;
      } catch (error) {
        this.error = error;
        this.changed("Not saved", error);
        throw error;
      }
    }
    this.changed("Saved on this Mac", null, this.note);
    return this.note;
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
