"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Spool } = require("./spool");
const files = require("../workspace/files");
function cleanScratch(spool) {
  const directory = path.dirname(
    files.managedPath(spool.directory, "scratch/.guard"),
  );
  if (!files.inspect(directory, true)) return;
  for (const name of fs.readdirSync(directory)) {
    if (!/^focusbae-utt-[0-9a-f]+\.wav$/.test(name)) continue;
    const file = files.managedPath(directory, name);
    if (files.inspect(file)) fs.unlinkSync(file);
  }
  files.flushDirectory(directory);
}
function recover(store) {
  const scope = { workspaceId: store.identity.id };
  for (const row of store._db
    .prepare(
      "SELECT id FROM recordings WHERE deleted_at IS NULL AND json_extract(data_json,'$.metadata.localCaptureVersion')=1",
    )
    .all()) {
    const recording = store.get(scope, "recording", row.id);
    try {
      const spool = new Spool(store, row.id).open();
      cleanScratch(spool);
      // Finish a crash between committing the transcript and writing its cleanup
      // tombstone. Retention is recorded before capture and survives this boundary.
      if (!recording.keepAudio && recording.transcriptionState === "complete" &&
          !spool.manifest.discarded && !spool.manifest.purged)
        spool.purge();
      if (spool.manifest.discarded || spool.manifest.purged)
        spool.purge(spool.manifest.discarded);
      if (
        spool.manifest.discarded &&
        recording.transcriptionState !== "complete" &&
        recording.transcriptionState !== "cancelled"
      ) {
        store.updateRecording(
          {
            ...scope,
            clientRequestId: randomUUID(),
            expectedRevision: recording.revision,
          },
          row.id,
          {
            transcriptionState: "cancelled",
            metadata: {
              ...recording.metadata,
              reason:
                "Audio deleted. Existing transcript text was kept.",
            },
          },
        );
        continue;
      }
      const interrupted = ["preparing", "recording", "stopping"].includes(
        recording.state,
      );
      const processing = recording.transcriptionState === "running";
      if (!interrupted && !processing) continue;
      const scan = spool.scan();
      const reason = interrupted
        ? "The app stopped before capture finished. The uncommitted tail may be missing."
        : "Transcription was interrupted. Saved audio is ready to retry.";
      spool.save({
        state: interrupted ? "interrupted" : recording.state,
        processing: "queued",
        reason,
        issues: scan.issues,
        bytes: scan.bytes,
        chunks: scan.chunks.length,
        durationMs: scan.durationMs,
      });
      store.updateRecording(
        {
          ...scope,
          clientRequestId: randomUUID(),
          expectedRevision: recording.revision,
        },
        row.id,
        {
          ...(interrupted
            ? {
                state: "interrupted",
                endedAt: new Date(
                  Math.max(
                    Date.parse(recording.startedAt),
                    Date.parse(
                      spool.manifest.lastCommit ?? recording.startedAt,
                    ),
                  ),
                ).toISOString(),
              }
            : {}),
          transcriptionState: "queued",
          metadata: {
            ...recording.metadata,
            reason,
            durationMs: scan.durationMs,
            issues: scan.issues,
          },
        },
      );
    } catch {
      store.recoveryReport.push({
        code: "SPOOL_RECOVERY_REQUIRED",
        recordingId: row.id,
      });
      if (["preparing", "recording", "stopping"].includes(recording.state))
        store.updateRecording(
          {
            ...scope,
            clientRequestId: randomUUID(),
            expectedRevision: recording.revision,
          },
          row.id,
          {
            state: "interrupted",
            endedAt: new Date(
              Math.max(Date.now(), Date.parse(recording.startedAt)),
            ).toISOString(),
            transcriptionState: "failed",
            metadata: {
              ...recording.metadata,
              reason:
                "Audio recovery needs attention. Existing files were kept.",
            },
          },
        );
    }
  }
}
module.exports = { recover };
