"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation } = require("./helpers.cjs");
const { SemanticSearch, chunks } = require("../../workspace/semantic-search");

const document = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

class SyntheticEmbedding {
  async embed(texts) {
    return {
      profile: "synthetic-semantic-v1",
      dimensions: 3,
      vectors: texts.map((text) => {
        const value = text.toLowerCase();
        if (value.includes("infrastructure") || value.includes("cloud spending")) return [1, 0, 0];
        if (value.includes("holiday")) return [0, 1, 0];
        return [0, 0, 1];
      }),
    };
  }
}

test("hybrid search finds paraphrases and rejects stale derived revisions", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const cloud = store.createNote(mutation(store), {
    title: "Operations",
    content: document("We agreed to cut cloud spending next quarter."),
  });
  store.createNote(mutation(store), {
    title: "Holiday",
    content: document("The team holiday is in December."),
  });
  const catalog = { store };
  const search = new SemanticSearch({ catalog, embedder: new SyntheticEmbedding() });
  t.after(() => search.close());

  const result = await search.query(store, workspaceId, "reduce infrastructure costs");
  assert.equal(result.mode, "hybrid");
  assert.equal(result.coverage.indexed, 2);
  assert.equal(result.items[0].id, cloud.id);
  assert.equal(result.items[0].match, "semantic");

  store.updateNote(mutation(store, 1), cloud.id, {
    content: document("The cloud migration is complete."),
  });
  const next = await search.query(store, workspaceId, "reduce infrastructure costs");
  assert.notEqual(next.items[0]?.id, cloud.id);
});

test("semantic chunking is bounded and preserves source offsets", () => {
  const text = `${"alpha ".repeat(300)}\n\nfinal paragraph`;
  const result = chunks(text);
  assert.ok(result.length > 1);
  assert.ok(result.every((chunk) => chunk.text.length <= 1200));
  assert.ok(result.every((chunk) => text.slice(chunk.startOffset, chunk.endOffset).trim() === chunk.text));
});

test("switching workspaces disposes the old index without nulling the new one", async (t) => {
  const first = (await fixture(t)).store;
  const second = (await fixture(t)).store;
  const search = new SemanticSearch({ catalog: null, embedder: new SyntheticEmbedding() });
  t.after(() => search.close());
  for (const store of [first, second])
    store.createNote(mutation(store), {
      title: "Budget",
      content: document("We agreed to cut cloud spending next quarter."),
    });

  const one = await search.query(first, first.identity.id, "infrastructure costs");
  assert.ok(one.items.length > 0);
  // The previous implementation called the async close() here, whose continuation
  // could null this.db after the new handle was assigned.
  const two = await search.query(second, second.identity.id, "infrastructure costs");
  assert.ok(two.items.length > 0);
  assert.equal(search.workspaceId, second.identity.id);
  // Going back must reopen rather than reuse a closed handle.
  const three = await search.query(first, first.identity.id, "infrastructure costs");
  assert.ok(three.items.length > 0);
});
