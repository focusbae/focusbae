"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ClipboardHistory } = require("../../workspace/clipboard-history");
function fixture(t) {
  let text = "before consent", formats = ["text/plain"], reads = 0;
  const clipboard = {
    availableFormats: () => { reads++; return formats; },
    readText: () => { reads++; return text; },
    writeText: (value) => { text = value; },
  };
  const history = new ClipboardHistory(clipboard);
  t.after(() => history.close());
  return { history, set: (value, types = ["text/plain"]) => { text = value; formats = types; }, text: () => text, reads: () => reads };
}
test("clipboard stays off without OS reads, skips pre-consent contents and clears on disable", (t) => {
  const f = fixture(t);
  f.history.poll(); assert.equal(f.reads(), 0);
  assert.deepEqual(f.history.snapshot(), { enabled: false, items: [] });
  f.history.setEnabled(true); f.history.poll(); assert.equal(f.history.items.length, 0);
  f.set("New local text"); f.history.poll();
  assert.equal(f.history.items[0].text, "New local text");
  f.history.setEnabled(false);
  assert.deepEqual(f.history.snapshot(), { enabled: false, items: [] });
  const reads = f.reads(); f.history.poll(); assert.equal(f.reads(), reads);
  f.history.setEnabled(true); f.history.poll(); assert.equal(f.history.items.length, 0);
});
test("clipboard bounds history, ignores common secret markers, copies and removes by ID", (t) => {
  const f = fixture(t); f.history.setEnabled(true);
  for (let n = 0; n < 35; n++) { f.set(`Item ${n}`); f.history.poll(); }
  assert.equal(f.history.items.length, 30);
  for (const format of ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "application/x-password"]) {
    f.set("secret", [format]); f.history.poll();
  }
  f.set("x".repeat(20001)); f.history.poll();
  assert.equal(f.history.items.length, 30); assert.equal(f.history.items[0].text, "Item 34");
  const id = f.history.items[2].id; f.history.copy(id); assert.equal(f.text(), "Item 32");
  f.history.remove(id); assert.throws(() => f.history.copy(id), { code: "NOT_FOUND" });
  f.history.clear(); f.history.poll(); assert.equal(f.history.items.length, 0);
  assert.equal(f.text(), "Item 32");
  f.history.close(); assert.equal(f.history.timer, null);
});
test("clipboard duplicate text moves to front and snapshots cannot mutate stored items", (t) => {
  const f = fixture(t); f.history.setEnabled(true);
  for (const value of ["one", "two", "one"]) { f.set(value); f.history.poll(); }
  assert.deepEqual(f.history.items.map((item) => item.text), ["one", "two"]);
  const copy = f.history.snapshot(); copy.items[0].text = "modified";
  assert.equal(f.history.items[0].text, "one");
});
