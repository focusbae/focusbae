"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const v = require("./validation");
const { check } = require("./errors");

const CACHE_VERSION = 1;
const MAX_CHUNK = 1200;

function vector(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function chunks(text) {
  const source = text.trim();
  if (!source) return [];
  const result = [];
  let cursor = 0;
  for (const paragraph of source.split(/\n{2,}/)) {
    const value = paragraph.trim();
    if (!value) continue;
    const sourceStart = source.indexOf(value, cursor);
    let offset = 0;
    while (offset < value.length) {
      let end = Math.min(value.length, offset + MAX_CHUNK);
      if (end < value.length) {
        const boundary = value.lastIndexOf(" ", end);
        if (boundary > offset + MAX_CHUNK / 2) end = boundary;
      }
      const content = value.slice(offset, end).trim();
      if (content)
        result.push({
          text: content,
          startOffset: sourceStart + offset,
          endOffset: sourceStart + end,
          hash: v.hash(content),
        });
      offset = end;
    }
    cursor = sourceStart + value.length;
  }
  return result.slice(0, 1000);
}

function liveSource(store, workspaceId, kind, id) {
  try {
    return store.get({ workspaceId }, kind, id);
  } catch {
    return null;
  }
}

class SemanticSearch {
  constructor({ catalog, embedder }) {
    this.catalog = catalog;
    this.embedder = embedder;
    this.db = null;
    this.workspaceId = null;
    this.profile = null;
    this.dimensions = null;
    this.tail = Promise.resolve();
  }

  async _profile() {
    if (this.profile) return { profile: this.profile, dimensions: this.dimensions };
    const result = await this.embedder.embed(["FocusBae local search"]);
    this.profile = result.profile;
    this.dimensions = result.dimensions;
    return result;
  }

  async status() {
    try {
      const { profile, dimensions } = await this._profile();
      return { available: true, profile, dimensions, language: "English" };
    } catch (error) {
      return { available: false, profile: null, dimensions: null, language: "English", reason: error.code ?? "UNAVAILABLE" };
    }
  }

  async _open(store, workspaceId) {
    const profile = await this._profile();
    if (this.db && this.workspaceId === workspaceId) return this.db;
    this._dispose();
    const file = path.join(store._directory, "search.sqlite");
    const db = new Database(file);
    fs.chmodSync(file, 0o600);
    const extension = sqliteVec.getLoadablePath().replace("app.asar/", "app.asar.unpacked/");
    db.loadExtension(extension);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        cache_version INTEGER NOT NULL,
        profile TEXT NOT NULL,
        dimensions INTEGER NOT NULL
      ) STRICT;
    `);
    const meta = db.prepare("SELECT * FROM semantic_meta WHERE singleton=1").get();
    if (meta && (meta.cache_version !== CACHE_VERSION || meta.profile !== profile.profile || meta.dimensions !== profile.dimensions)) {
      db.exec("DROP TABLE IF EXISTS semantic_vectors; DROP TABLE IF EXISTS semantic_chunks; DELETE FROM semantic_meta;");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_chunks (
        rowid INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        UNIQUE(entity_kind,entity_id,source_revision,chunk_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS semantic_source ON semantic_chunks(entity_kind,entity_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vectors USING vec0(
        embedding float[${profile.dimensions}] distance_metric=cosine
      );
      INSERT OR IGNORE INTO semantic_meta VALUES (1,${CACHE_VERSION},'${profile.profile.replaceAll("'", "''")}',${profile.dimensions});
    `);
    this.db = db;
    this.workspaceId = workspaceId;
    return db;
  }

  async _sync(store, workspaceId) {
    const db = await this._open(store, workspaceId);
    const documents = store._db.prepare(
      "SELECT entity_kind AS kind,entity_id AS id,title,body FROM search_documents WHERE workspace_id=? ORDER BY entity_kind,entity_id",
    ).all(workspaceId);
    const current = new Map();
    for (const document of documents) {
      const source = liveSource(store, workspaceId, document.kind, document.id);
      if (!source) continue;
      const content = [document.title, document.body].filter(Boolean).join("\n\n");
      current.set(`${document.kind}:${document.id}`, { ...document, revision: source.revision, chunks: chunks(content) });
    }
    const stale = db.prepare("SELECT DISTINCT entity_kind AS kind,entity_id AS id,source_revision AS revision FROM semantic_chunks").all()
      .filter((row) => current.get(`${row.kind}:${row.id}`)?.revision !== row.revision);
    const removeVectors = db.prepare("DELETE FROM semantic_vectors WHERE rowid IN (SELECT rowid FROM semantic_chunks WHERE entity_kind=? AND entity_id=?)");
    const removeChunks = db.prepare("DELETE FROM semantic_chunks WHERE entity_kind=? AND entity_id=?");
    db.transaction(() => {
      for (const row of stale) {
        removeVectors.run(row.kind, row.id);
        removeChunks.run(row.kind, row.id);
      }
    }).immediate();
    const exists = db.prepare("SELECT 1 FROM semantic_chunks WHERE entity_kind=? AND entity_id=? AND source_revision=? LIMIT 1");
    const pending = [...current.values()].filter((item) => item.chunks.length && !exists.get(item.kind, item.id, item.revision));
    const insertChunk = db.prepare(`INSERT INTO semantic_chunks
      (workspace_id,entity_kind,entity_id,source_revision,title,text,start_offset,end_offset,chunk_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const insertVector = db.prepare("INSERT INTO semantic_vectors(rowid,embedding) VALUES (?,?)");
    for (const item of pending) {
      for (let offset = 0; offset < item.chunks.length; offset += 32) {
        const batch = item.chunks.slice(offset, offset + 32);
        const embedded = await this.embedder.embed(batch.map((chunk) => chunk.text));
        check(embedded.profile === this.profile && embedded.dimensions === this.dimensions, "MODEL_INVALID", "Embedding profile changed");
        db.transaction(() => {
          batch.forEach((chunk, index) => {
            const info = insertChunk.run(workspaceId, item.kind, item.id, item.revision, item.title, chunk.text, chunk.startOffset, chunk.endOffset, chunk.hash);
            insertVector.run(BigInt(info.lastInsertRowid), vector(embedded.vectors[index]));
          });
        }).immediate();
      }
    }
    return { indexed: current.size, total: documents.length };
  }

  query(store, workspaceId, query, options = {}) {
    const result = this.tail.then(() => this._query(store, workspaceId, query, options));
    this.tail = result.catch(() => {});
    return result;
  }

  async _query(store, workspaceId, query, { limit = 50 } = {}) {
    v.text(query, "query", 2000);
    v.integer(limit, "limit", 1, 100);
    const coverage = await this._sync(store, workspaceId);
    const db = this.db;
    const embedded = await this.embedder.embed([query]);
    check(embedded.profile === this.profile && embedded.dimensions === this.dimensions, "MODEL_INVALID", "Embedding profile changed");
    const semantic = db.prepare(`SELECT c.entity_kind AS kind,c.entity_id AS id,c.source_revision AS revision,
      c.title,c.text AS body,c.start_offset AS startOffset,c.end_offset AS endOffset,v.distance
      FROM semantic_vectors v JOIN semantic_chunks c ON c.rowid=v.rowid
      WHERE v.embedding MATCH ? AND k = 40 ORDER BY v.distance`).all(vector(embedded.vectors[0]));
    const lexical = store.search({ workspaceId }, query, { limit: 40 });
    const scores = new Map();
    const add = (item, rank, channel) => {
      const key = `${item.kind}:${item.id}`;
      const old = scores.get(key) ?? { ...item, score: 0, channels: new Set() };
      old.score += 1 / (60 + rank);
      old.channels.add(channel);
      if (channel === "semantic" && !old.startOffset) Object.assign(old, item);
      scores.set(key, old);
    };
    lexical.forEach((item, index) => add(item, index + 1, "lexical"));
    semantic.filter((item) => item.distance <= 0.65).forEach((item, index) => {
      const current = liveSource(store, workspaceId, item.kind, item.id);
      if (current?.revision === item.revision) add(item, index + 1, "semantic");
    });
    const items = [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ channels, score, ...item }) => ({
        ...item,
        body: item.body.slice(0, 600),
        match: channels.size === 2 ? "hybrid" : [...channels][0],
      }));
    return { items, total: items.length, mode: "hybrid", coverage };
  }

  _dispose() {
    if (this.db?.open) this.db.close();
    this.db = null;
    this.workspaceId = null;
  }

  async close() {
    await this.tail;
    this._dispose();
  }
}

module.exports = { SemanticSearch, chunks, vector };
