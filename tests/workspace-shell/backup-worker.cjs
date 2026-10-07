"use strict";
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { BackupService } = require("../../workspace/backup");
const [root, file, method] = process.argv.slice(2);
(async () => {
  const catalog = new WorkspaceCatalog(root); await catalog.initialize();
  const backups = new BackupService(catalog);
  backups.on("change", ({ phase }) => {
    if ((method === "create" && phase === "Verifying the backup…") ||
      (method === "restore" && phase === "Preparing an independent restored workspace…")) process.kill(process.pid, "SIGKILL");
  });
  if (method === "create") await catalog.serialize(() => backups.create(catalog.activeId, file));
  else await catalog.serialize(() => backups.restore(file));
  throw new Error("Crash checkpoint was not reached");
})().catch((error) => { process.stderr.write(error.stack); process.exit(1); });
