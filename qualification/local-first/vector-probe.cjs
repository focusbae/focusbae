const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

function loadVector(db) {
  // Load only this bundled extension, never a renderer- or model-supplied path.
  const extension = sqliteVec.getLoadablePath().replace('app.asar/', 'app.asar.unpacked/');
  db.loadExtension(extension);
}

function vector(values) { return Buffer.from(new Float32Array(values).buffer); }

async function probeVector(directory) {
  const file = path.join(directory, 'vectors.sqlite');
  const backupFile = path.join(directory, 'vectors-backup.sqlite');
  let db = new Database(file);
  const checks = [];
  try {
    loadVector(db);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec(`CREATE VIRTUAL TABLE chunks USING vec0(
      embedding float[3] distance_metric=cosine,
      project text,
      source_revision integer
    )`);
    const insert = db.prepare('INSERT INTO chunks(rowid, embedding, project, source_revision) VALUES (?, ?, ?, ?)');
    // better-sqlite3 binds JS numbers as doubles; vec0 INTEGER fields need BigInt.
    insert.run(1n, vector([1, 0, 0]), 'synthetic-project-with-long-name', 1n);
    insert.run(2n, vector([0.8, 0.2, 0]), 'synthetic-project-with-long-name', 1n);
    insert.run(3n, vector([1, 0, 0]), 'other-project', 1n);
    const nearest = () => db.prepare(`SELECT rowid, distance FROM chunks
      WHERE embedding MATCH ? AND k = 2 AND project = ? ORDER BY distance`)
      .all(vector([1, 0, 0]), 'synthetic-project-with-long-name');
    assert.deepEqual(nearest().map((row) => row.rowid), [1, 2]);
    checks.push('Cosine KNN and metadata prefilter before top-k');
    assert.throws(() => insert.run(4n, vector([1, 0]), 'invalid', 1n), /dimension/i);
    checks.push('Wrong-dimensional vector rejected');
    assert.throws(() => db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE rowid = ?').run(1n);
      throw new Error('Synthetic interruption');
    })(), /Synthetic interruption/);
    assert.deepEqual(nearest().map((row) => row.rowid), [1, 2]);
    db.prepare('DELETE FROM chunks WHERE rowid = ?').run(1n);
    assert.deepEqual(nearest().map((row) => row.rowid), [2]);
    checks.push('Transactional rollback and long-text metadata deletion regression');
    await db.backup(backupFile);
    const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
    try {
      loadVector(backup);
      assert.equal(backup.prepare('SELECT count(*) AS n FROM chunks').get().n, 2);
      assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    } finally { backup.close(); }
    checks.push('Active-WAL vector backup can reopen with the bundled extension');
    db.close();
    db = new Database(file, { fileMustExist: true });
    loadVector(db);
    assert.deepEqual(nearest().map((row) => row.rowid), [2]);
    checks.push('Vector query survives close/reopen');

    // Deterministic numeric vectors measure index cost, NOT semantic relevance.
    db.exec('CREATE VIRTUAL TABLE benchmark USING vec0(embedding float[384] distance_metric=cosine)');
    const add = db.prepare('INSERT INTO benchmark(rowid, embedding) VALUES (?, ?)');
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    const count = 10000;
    const started = performance.now();
    db.transaction(() => {
      for (let row = 1; row <= count; row += 1) {
        add.run(BigInt(row), vector(Array.from({ length: 384 }, random)));
      }
    })();
    const indexingMs = performance.now() - started;
    const query = db.prepare('SELECT rowid, distance FROM benchmark WHERE embedding MATCH ? AND k = 10 ORDER BY distance');
    const timings = [];
    for (let i = 0; i < 31; i += 1) {
      const embedding = vector(Array.from({ length: 384 }, random));
      const start = performance.now();
      assert.equal(query.all(embedding).length, 10);
      timings.push(performance.now() - start);
    }
    const firstQueryMs = timings.shift();
    timings.sort((a, b) => a - b);
    return {
      package: require('./package.json').dependencies['sqlite-vec'],
      extension: db.prepare('SELECT vec_version() AS version').get().version,
      checks,
      benchmark: { count, dimensions: 384, runs: timings.length, indexingMs, firstQueryMs, warmP50Ms: timings[14], warmP95Ms: timings[28], rawVectorBytes: count * 384 * 4 },
      limitation: 'Synthetic vectors only; no embedding model, real retrieval evaluation, cold-cache or concurrent capture test',
    };
  } finally { if (db.open) db.close(); }
}

module.exports = { probeVector };
