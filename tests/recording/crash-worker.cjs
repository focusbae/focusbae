"use strict";
// Synthetic PCM only; exercise actual process death with all network APIs denied.
const deny = () => {
  throw new Error("Network is forbidden");
};
global.fetch = deny;
for (const name of ["http", "https"])
  for (const method of ["request", "get"]) require(name)[method] = deny;
require("net").Socket.prototype.connect = deny;
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { RecordingService } = require("../../recording/service");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
(async () => {
  const catalog = new WorkspaceCatalog(process.argv[2]);
  await catalog.initialize();
  const service = new RecordingService({
    catalog,
    model: () => ({ ready: false }),
    capabilities: () => ({ microphone: { ok: true } }),
    createSource: () => {
      const source = new EventEmitter();
      source.start = async () => source.emit("audio", Buffer.alloc(160000));
      source.stop = async () => {};
      return source;
    },
  });
  const record = service.start({
    context: {
      workspaceId: catalog.store.identity.id,
      clientRequestId: randomUUID(),
    },
    purpose: "personal",
    sourceMode: "microphone",
    language: "english",
    consent: true,
    destination: { kind: "standalone" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  process.send({ record, bytes: service.active.spool.manifest.bytes });
  setInterval(() => {}, 10000);
})().catch((error) => {
  process.send({ error: error.message });
  process.exit(1);
});
