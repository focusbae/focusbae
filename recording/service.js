"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Segmenter, _rms: rms } = require("../meeting-capture/segmenter");
const { SILENCE_TIMEOUT_MS, MAX_DURATION_MS } = require("../meeting-capture/limits");
const { Spool, CHUNK_BYTES } = require("./spool");
const native = require("./sources");
const v = require("../workspace/validation");
const files = require("../workspace/files");
const { check } = require("../workspace/errors");
const scope = (store) => ({ workspaceId: store.identity.id });
const mutation = (store, revision) => ({
  ...scope(store),
  clientRequestId: randomUUID(),
  ...(revision ? { expectedRevision: revision } : {}),
});
const REASONS = {
  user: null,
  quit: "Stopped when the app quit.",
  sleep: "Stopped for sleep. Audio after suspension is not included.",
  silence: "Stopped after 15 minutes without detected speech.",
  duration: "Stopped at the four-hour safety limit.",
  source:
    "A selected source stopped or stopped supplying audio. The uncommitted tail may be incomplete.",
  disk: "Storage could not keep up or ran out of space. The uncommitted audio tail may be missing.",
  startup:
    "A selected source could not start. Any available partial audio was kept.",
};
function publicRecording(record) {
  const imported = record.metadata?.importedWavVersion === 1;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    revision: record.revision,
    title: record.title ?? "",
    purpose: record.purpose,
    sourceMode: imported ? "import" : record.sourceMode,
    imported,
    state: record.state,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    transcriptionState: record.transcriptionState,
    keepAudio: record.keepAudio,
    originalName: record.metadata?.originalName ?? null,
    localCapture: record.metadata?.localCaptureVersion === 1,
    reason: record.metadata?.reason ?? null,
    durationMs: record.metadata?.durationMs ?? 0,
    language: record.metadata?.language ?? "english",
    issues: record.metadata?.issues ?? [],
    suggestions: record.metadata?.actionExtraction ?? null,
    diarization: record.metadata?.diarization ?? null,
    aiState: record.aiState,
  };
}
// On speakers rather than headphones the far side comes out of the Mac and back in
// through the microphone, so the same words appear on both sources a fraction of a
// second apart. Both copies are kept -- a microphone segment can contain the user's
// own words as well -- but the duplicate is marked so the transcript can read as one
// conversation. The system copy is the original; the microphone copy is the echo.
function markEchoes(segments) {
  const { echoOf, sameWords, segmentSpans } = require("../workspace/action-extraction");
  const spans = segmentSpans(segments);
  return segments.map((segment) => {
    if (segment.source !== "microphone") return { ...segment, echoOf: null };
    const original = segments.find(
      (other) =>
        other.source === "system" &&
        echoOf(other.id, segment.id, spans) &&
        sameWords(other.text, segment.text),
    );
    return { ...segment, echoOf: original?.id ?? null };
  });
}

function requestId(key) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
class RecordingService extends EventEmitter {
  constructor({
    catalog,
    createSource = native.createSource,
    capabilities = native.capabilities,
    speech = null,
    model = null,
    createEngine = null,
    legacyBusy = () => false,
    clock = () => performance.now(),
    startTimeout = 15000,
    sourceTimeout = 5000,
    silenceTimeout = SILENCE_TIMEOUT_MS,
    maxDuration = MAX_DURATION_MS,
    extractor = null,
    diarizer = null,
  } = {}) {
    super();
    Object.assign(this, {
      catalog,
      createSource,
      capabilities,
      legacyBusy,
      clock,
      startTimeout,
      sourceTimeout,
      silenceTimeout,
      maxDuration,
      extractor,
      diarizer,
      speech,
    });
    // Readiness is per recording language; see recording/speech.js for routing.
    this.model =
      model ??
      ((language) =>
        speech ? speech.state(language) : { ready: false, model: null, engine: null });
    this.createEngine = createEngine ?? ((options) => speech.createEngine(options));
    this.active = null;
    this.processing = null;
    this.importing = false;
    this.closing = false;
  }
  busy() {
    return !!this.active || !!this.processing || this.importing;
  }
  snapshot() {
    return {
      active: this.active
        ? {
            ...publicRecording(this.current(this.active)),
            levels: { ...this.active.levels },
            durableMs: this.active.spool?.manifest.durationMs ?? 0,
          }
        : null,
      processingId: this.processing?.id ?? null,
      importing: this.importing,
      capabilities: this.capabilities(),
      model: this.model(),
    };
  }
  emitChange() {
    this.emit("change");
  }
  current(session) {
    return session.store.get(scope(session.store), "recording", session.id);
  }
  update(session, changes) {
    const old = this.current(session);
    return session.store.updateRecording(
      mutation(session.store, old.revision),
      old.id,
      { ...changes, metadata: { ...old.metadata, ...changes.metadata } },
    );
  }
  start(input) {
    v.object(input, [
      "context",
      "purpose",
      "sourceMode",
      "destination",
      "language",
      "consent",
      "keepAudio",
    ]);
    const store = this.catalog.scoped(input.context.workspaceId);
    const { context, ...args } = input;
    v.choice(
      input.purpose,
      ["conversation", "personal", "learning"],
      "purpose",
    );
    v.choice(input.sourceMode, ["microphone", "system", "both"], "source");
    v.choice(input.language, ["english", "hindi", "mixed"], "language");
    const keepAudio = v.boolean(input.keepAudio ?? false, "keepAudio");
    check(
      input.consent === true,
      "CONSENT_REQUIRED",
      "Confirm participant consent and temporary local audio storage",
    );
    v.object(input.destination, ["kind", "noteId"]);
    v.choice(
      input.destination.kind,
      ["standalone", "today", "note"],
      "destination",
    );
    if (input.destination.kind === "note")
      store.get(scope(store), "note", v.uuid(input.destination.noteId));
    else
      check(
        input.destination.noteId === undefined,
        "INVALID_INPUT",
        "Unexpected note ID",
      );
    const previous = store._request(context, "capture.start", args).previous;
    if (previous)
      return publicRecording(
        store.get(
          scope(store),
          "recording",
          JSON.parse(previous.result_json).id,
        ),
      );
    check(
      !this.closing && !this.busy() && !this.legacyBusy(),
      "WORKSPACE_BUSY",
      "Another capture or transcription is active",
    );
    const kinds =
      input.sourceMode === "both"
        ? ["microphone", "system"]
        : [input.sourceMode];
    const support = this.capabilities();
    for (const kind of kinds)
      check(support[kind].ok, "SOURCE_UNAVAILABLE", `${kind} is unavailable`);
    const recording = store._mutate(context, "capture.start", args, () => {
      const record = store.createRecording(mutation(store), {
        purpose: input.purpose,
        sourceMode: input.sourceMode,
        keepAudio,
        consent: {
          version: 1,
          acknowledgedAt: new Date().toISOString(),
          temporaryAudio: true,
          retainedAudio: keepAudio,
          participantConsent: true,
        },
        metadata: { localCaptureVersion: 1, language: input.language },
      });
      const noteId =
        input.destination.kind === "today"
          ? store.dailyNote(mutation(store)).id
          : input.destination.noteId;
      if (noteId)
        store.linkRecording(mutation(store), {
          recordingId: record.id,
          noteId,
        });
      return record;
    });
    const session = {
      id: recording.id,
      store,
      origin: this.clock(),
      lastVoice: this.clock(),
      sources: {},
      buffers: {},
      offsets: {},
      sequences: {},
      lastInput: {},
      levels: {},
      accepting: true,
      stopping: null,
      startCancelled: false,
    };
    this.active = session;
    try {
      session.spool = new Spool(store, recording.id).create(
        recording,
        input.language,
      );
    } catch {
      this.update(session, {
        state: "failed",
        endedAt: new Date().toISOString(),
        metadata: { reason: REASONS.disk },
      });
      this.active = null;
      this.emitChange();
      return publicRecording(this.current(session));
    }
    session.starting = this.acquire(session, kinds)
      .catch((error) => {
        session.startError = String(error?.message ?? error).slice(0, 300);
        return this.stop(session.id, "startup");
      })
      .catch(() => {});
    this.emitChange();
    return publicRecording(recording);
  }
  validateImport(input) {
    v.object(input, ["context", "purpose", "destination", "language", "keepAudio", "consent"]);
    const store = this.catalog.scoped(input.context.workspaceId);
    v.choice(input.purpose, ["conversation", "personal", "learning"], "purpose");
    v.choice(input.language, ["english", "hindi", "mixed"], "language");
    v.boolean(input.keepAudio, "keepAudio");
    check(input.consent === true, "CONSENT_REQUIRED", "Confirm permission to use this audio");
    v.object(input.destination, ["kind", "noteId"]);
    v.choice(input.destination.kind, ["standalone", "today", "note"], "destination");
    if (input.destination.kind === "note")
      store.get(scope(store), "note", v.uuid(input.destination.noteId));
    else check(input.destination.noteId === undefined, "INVALID_INPUT", "Unexpected note ID");
    return store;
  }
  guardImport() {
    check(!this.closing && !this.busy() && !this.legacyBusy(), "WORKSPACE_BUSY", "Finish active capture or processing first");
  }
  async importWav(input, file) {
    const store = this.validateImport(input);
    const { context, ...args } = input, keepAudio = input.keepAudio;
    const previous = store._request(context, "capture.import", args).previous;
    if (previous)
      return publicRecording(store.get(scope(store), "recording", JSON.parse(previous.result_json).id));
    this.guardImport();
    // Validate the source before creating a recording. The native dialog owns the
    // path; only a bounded display name is committed to the workspace.
    const wav = require("./wav");
    const inspected = wav.inspectWav(file);
    require("node:fs").closeSync(inspected.fd);
    const displayName = require("node:path").basename(file)
      .replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, 240);
    const record = store._mutate(context, "capture.import", args, () => {
      const created = store.createRecording(mutation(store), {
        purpose: input.purpose,
        sourceMode: "microphone",
        keepAudio,
        consent: { version: 1, acknowledgedAt: new Date().toISOString(), importedAudio: true },
        metadata: { localCaptureVersion: 1, importedWavVersion: 1, language: input.language, originalName: displayName },
      });
      const noteId = input.destination.kind === "today"
        ? store.dailyNote(mutation(store)).id : input.destination.noteId;
      if (noteId) store.linkRecording(mutation(store), { recordingId: created.id, noteId });
      return created;
    });
    const session = { id: record.id, store };
    this.importing = true;
    this.emitChange();
    try {
      const spool = new Spool(store, record.id).create(record, input.language);
      const result = await wav.importToSpool(file, spool);
      spool.save({ state: "captured", processing: "queued" });
      this.update(session, { state: "recording" });
      this.update(session, { state: "stopping" });
      this.update(session, {
        state: "captured",
        endedAt: new Date().toISOString(),
        metadata: { durationMs: result.durationMs, importedFormat: result.input },
      });
    } catch (error) {
      try {
        this.update(session, { state: "failed", endedAt: new Date().toISOString(),
          metadata: { reason: "Audio import did not finish. The original file was left unchanged." } });
      } catch {}
      if (["ENOSPC", "EDQUOT", "SQLITE_FULL"].includes(error.code))
        check(false, "DISK_FULL", "Storage is full while importing audio");
      throw error;
    } finally {
      this.importing = false;
      this.emitChange();
    }
    if (!this.closing && this.model(input.language).ready) {
      try { await this.retry(record.id); } catch { /* Imported audio remains available. */ }
    }
    return publicRecording(this.current(session));
  }
  storage(workspaceId) {
    const store = this.catalog.scoped(v.uuid(workspaceId));
    const result = { retainedBytes: 0, temporaryBytes: 0, retainedCount: 0, temporaryCount: 0 };
    for (const { id } of store._db.prepare(
      "SELECT id FROM recordings WHERE deleted_at IS NULL AND json_extract(data_json,'$.metadata.localCaptureVersion')=1",
    ).iterate()) {
      try {
        const record = store.get(scope(store), "recording", id);
        const spool = new Spool(store, id).open();
        if (spool.manifest.purged || spool.manifest.discarded) continue;
        const key = record.keepAudio ? "retained" : "temporary";
        result[`${key}Bytes`] += spool.manifest.bytes;
        result[`${key}Count`]++;
      } catch { /* Detail view reports any recording needing recovery. */ }
    }
    return { ...result, totalBytes: result.retainedBytes + result.temporaryBytes };
  }
  async acquire(session, kinds) {
    const acquisitions = kinds.map(async (kind) => {
      const source = this.createSource(kind);
      session.sources[kind] = source;
      session.buffers[kind] = Buffer.alloc(0);
      session.sequences[kind] = 0;
      session.levels[kind] = 0;
      let ready, fail;
      const received = new Promise((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
      session.cancelStart ??= [];
      session.cancelStart.push(() => fail(new Error("Start cancelled")));
      source.on("audio", (bytes) => {
        if (session.accepting) {
          this.audio(session, kind, bytes);
          ready();
        }
      });
      source.on("error", () => {
        fail(new Error("Source unavailable"));
        if (
          this.active === session &&
          this.current(session).state === "recording"
        )
          this.stop(session.id, "source").catch(() => {});
      });
      const timeout = setTimeout(
        () => fail(new Error("No audio from selected source")),
        this.startTimeout,
      );
      try {
        await Promise.all([source.start(), received]);
      } finally {
        clearTimeout(timeout);
      }
    });
    await Promise.all(acquisitions);
    if (session.startCancelled || !session.accepting || this.active !== session)
      return;
    session.spool.save({ state: "recording" });
    this.update(session, { state: "recording" });
    session.timer = setInterval(() => {
      const now = this.clock();
      let reason;
      if (now - session.origin >= this.maxDuration) reason = "duration";
      else if (
        Object.values(session.lastInput).some(
          (time) => now - time >= this.sourceTimeout,
        )
      )
        reason = "source";
      else if (now - session.lastVoice >= this.silenceTimeout)
        reason = "silence";
      if (reason) this.stop(session.id, reason).catch(() => {});
      else this.emitChange();
    }, 1000);
    session.timer.unref?.();
    this.emitChange();
  }
  audio(session, kind, bytes) {
    if (!session.accepting) return;
    try {
      check(
        Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256000,
        "INVALID_AUDIO",
        "Input is not bounded PCM",
      );
      const now = this.clock();
      if (
        session.lastInput[kind] !== undefined &&
        now - session.lastInput[kind] > this.sourceTimeout + bytes.length / 32
      ) {
        this.stop(session.id, "source").catch(() => {});
        return;
      }
      session.lastInput[kind] = now;
      if (session.offsets[kind] === undefined)
        session.offsets[kind] = Math.max(
          0,
          Math.round(now - session.origin - bytes.length / 32),
        );
      const level = rms(bytes, 0, bytes.length - (bytes.length % 2));
      session.levels[kind] = Math.min(1, level / 16000);
      if (level > 180) session.lastVoice = now;
      session.buffers[kind] = Buffer.concat([session.buffers[kind], bytes]);
      while (session.buffers[kind].length >= CHUNK_BYTES)
        this.flushSource(session, kind, CHUNK_BYTES);
    } catch {
      session.accepting = false;
      this.stop(session.id, "disk").catch(() => {});
    }
  }
  flushSource(session, kind, size) {
    const pcm = session.buffers[kind].subarray(0, size);
    session.spool.append({
      source: kind,
      sequence: session.sequences[kind],
      startMs: session.offsets[kind],
      pcm,
    });
    session.buffers[kind] = session.buffers[kind].subarray(size);
    session.sequences[kind]++;
    session.offsets[kind] += pcm.length / 32;
  }
  stop(id, reason = "user") {
    const session = this.active;
    if (!session || session.id !== id) {
      const store = this.catalog.store;
      return Promise.resolve(
        publicRecording(store.get(scope(store), "recording", id)),
      );
    }
    if (session.stopping) return session.stopping;
    session.startCancelled = true;
    session.cancelStart?.forEach((cancel) => cancel());
    clearInterval(session.timer);
    session.stopping = this.finish(session, reason);
    return session.stopping;
  }
  async finish(session, reason) {
    let failure = reason;
    try {
      if (this.current(session).state === "recording")
        this.update(session, { state: "stopping" });
    } catch {
      failure = "disk";
    }
    this.emitChange();
    const stopped = await Promise.allSettled(
      Object.values(session.sources).map((source) => source.stop()),
    );
    if (
      stopped.some((item) => item.status === "rejected") &&
      failure === "user"
    )
      failure = "source";
    try {
      session.accepting = false;
      for (const kind of Object.keys(session.buffers)) {
        const size =
          session.buffers[kind].length - (session.buffers[kind].length % 2);
        if (size) this.flushSource(session, kind, size);
      }
    } catch {
      failure = "disk";
    }
    session.accepting = false;
    const interrupted =
      ["startup", "source", "disk", "sleep"].includes(failure) ||
      this.current(session).state === "preparing";
    let issues = [];
    try {
      issues = session.spool.scan().issues;
      session.spool.save({
        state: interrupted ? "interrupted" : "captured",
        reason: REASONS[failure],
        issues,
      });
    } catch {
      failure = "disk";
    }
    try {
      this.update(session, {
        state: interrupted || failure === "disk" ? "interrupted" : "captured",
        endedAt: new Date(
          Math.max(Date.now(), Date.parse(this.current(session).startedAt)),
        ).toISOString(),
        metadata: {
          reason: REASONS[failure],
          issues,
          durationMs: session.spool.manifest.durationMs,
          ...(session.startError ? { startError: session.startError } : {}),
        },
      });
    } finally {
      this.active = null;
      this.emitChange();
    }
    const language = session.spool?.manifest.language ?? "english";
    await this.speech?.prepare().catch(() => {});
    if (!this.closing && failure !== "disk" && this.model(language).ready) {
      try {
        await this.retry(session.id);
      } catch {
        /* Saved audio remains available for retry. */
      }
    }
    return publicRecording(this.current(session));
  }
  async retry(id) {
    // Probe engine availability first; the checks below then run without awaiting.
    await this.speech?.prepare().catch(() => {});
    check(
      !this.busy() && !this.closing && !this.legacyBusy(),
      "WORKSPACE_BUSY",
      "Finish active capture or processing first",
    );
    const store = this.catalog.store;
    const record = store.get(scope(store), "recording", id);
    check(
      record.metadata.localCaptureVersion === 1 &&
        ["captured", "interrupted", "failed"].includes(record.state),
      "INVALID_INPUT",
      "Recording cannot be processed",
    );
    const spool = new Spool(store, id).open();
    check(
      !spool.manifest.discarded,
      "INVALID_INPUT",
      "Temporary audio was deleted",
    );
    if (record.transcriptionState === "complete" && spool.manifest.purged)
      return Promise.resolve(publicRecording(record));
    check(
      this.model(spool.manifest.language).ready,
      "MODEL_MISSING",
      spool.manifest.language === "english"
        ? "Transcription needs Apple speech (macOS 26) or the Parakeet download"
        : "Hindi and mixed transcription need Apple speech on macOS 26 or later",
    );
    const task = {
      id,
      store,
      spool,
      cancelled: false,
      engine: this.createEngine({
        language: spool.manifest.language,
        directory: spool.directory,
      }),
    };
    this.processing = task;
    task.promise = this.process(task).finally(async () => {
      try {
        await task.engine.dispose();
        this.cleanScratch(spool);
      } finally {
        if (this.processing === task) this.processing = null;
        this.emitChange();
      }
    });
    task.promise.catch(() => {});
    return publicRecording(record);
  }
  async process(task) {
    const { store, id, spool, engine } = task;
    try {
      const scan = spool.scan();
      check(scan.chunks.length > 0, "NO_AUDIO", "No recoverable audio chunks");
      spool.save({ processing: "running" });
      this.update(task, {
        transcriptionState: "running",
        metadata: { issues: scan.issues },
      });
      this.emitChange();
      await engine.load();
      for (const source of require("./spool").SOURCES) {
        const pending = [];
        let offset = null,
          previousEnd = null;
        let segmenter;
        const reset = (start) => {
          offset = start;
          segmenter = new Segmenter({
            speaker: source,
            onUtterance: (value) =>
              pending.push({
                ...value,
                startMs: Math.round(offset + value.startMs),
                endMs: Math.round(offset + value.endMs),
              }),
          });
        };
        const drain = async () => {
          while (pending.length) {
            if (task.cancelled)
              throw Object.assign(new Error("Cancelled"), {
                code: "CANCELLED",
              });
            const utterance = pending.shift();
            const key = `${id}:${source}:${utterance.startMs}:${utterance.endMs}`;
            const existing = store._db
              .prepare(
                "SELECT id FROM transcript_segments WHERE recording_id=? AND json_extract(data_json,'$.provenance.spoolKey')=?",
              )
              .get(id, key);
            if (existing) continue;
            const result = await engine.transcribe(utterance);
            if (task.cancelled)
              throw Object.assign(new Error("Cancelled"), {
                code: "CANCELLED",
              });
            if (result?.content?.trim())
              store.createTranscript(
                { ...scope(store), clientRequestId: requestId(key) },
                {
                  recordingId: id,
                  source,
                  startMs: utterance.startMs,
                  endMs: utterance.endMs,
                  text: result.content.trim(),
                  speakerId: null,
                  provenance: {
                    spoolKey: key,
                    engine: engine.engine ?? "local-speech",
                    model: engine.model ?? this.model(spool.manifest.language).model,
                    language: spool.manifest.language,
                  },
                },
              );
            spool.save({ lastTranscribedKey: key });
            this.emitChange();
          }
        };
        for (const chunk of scan.chunks.filter(
          (chunk) => chunk.source === source,
        )) {
          if (
            offset === null ||
            (previousEnd !== null && Math.abs(chunk.startMs - previousEnd) > 2)
          ) {
            segmenter?.end();
            await drain();
            reset(chunk.startMs);
          }
          segmenter.push(spool.read(chunk.name).pcm);
          previousEnd = chunk.startMs + chunk.durationMs;
          await drain();
          await new Promise((resolve) => setImmediate(resolve));
        }
        segmenter?.end();
        await drain();
      }
      if (task.cancelled)
        throw Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
      // Gaps/corruption retain raw chunks for inspection; they are never called complete.
      check(
        !scan.issues.length,
        "AUDIO_GAPS",
        "Some audio chunks could not be processed",
      );
      // Speaker detection needs the audio, so it runs before the spool is purged,
      // and before extraction so proposals can see speaker turns. It never fails
      // the transcript.
      let diarization = { status: "skipped", reason: "MODEL_MISSING" };
      try {
        diarization = await require("./diarize").diarizeRecording({
          store,
          recordingId: id,
          spool,
          scan,
          runtime: this.diarizer,
          isCancelled: () => task.cancelled,
        });
      } catch (error) {
        if (error.code === "CANCELLED") throw error;
        diarization = { status: "failed", reason: error.code ?? "FAILED" };
      }
      let extraction = { proposed: 0 };
      try {
        extraction = await require("../workspace/action-extraction").extractActions(
          store,
          id,
          this.extractor,
        );
      } catch (error) {
        extraction = { proposed: 0, failed: true, reason: error.code ?? "FAILED" };
      }
      this.update(task, {
        transcriptionState: "complete",
        aiState: extraction.failed ? "failed" : "complete",
        metadata: {
          processingError: null,
          actionExtraction: extraction,
          diarization,
        },
      });
      spool.save({ processing: "complete" });
      if (!this.current(task).keepAudio) {
        try {
          spool.purge();
        } catch {
          /* Completed text stays complete; cleanup is retried on open. */
        }
      }
    } catch (error) {
      const state = task.cancelled ? "cancelled" : "failed";
      try {
        this.update(task, {
          transcriptionState: state,
          metadata: {
            processingError: task.cancelled
              ? "Processing cancelled. Temporary audio is kept."
              : "Local transcription did not finish. Saved audio and completed transcript segments were kept.",
          },
        });
        spool.save({ processing: state });
      } catch {
        /* The durable running state is reconciled on next open. */
      }
    }
  }
  cleanScratch(spool) {
    try {
      const directory = path.dirname(
        files.managedPath(spool.directory, "scratch/.guard"),
      );
      if (!files.inspect(directory, true)) return;
      for (const name of fs.readdirSync(directory))
        if (/^focusbae-utt-[0-9a-f]+\.wav$/.test(name)) {
          const file = files.managedPath(directory, name);
          if (files.inspect(file)) fs.unlinkSync(file);
        }
      files.flushDirectory(directory);
    } catch {
      /* No path escapes or destructive recovery on unknown files. */
    }
  }
  async cancel(id) {
    const task = this.processing;
    if (!task || task.id !== id) return;
    task.cancelled = true;
    await task.engine.dispose();
    await task.promise;
  }
  async close() {
    this.closing = true;
    try {
      if (this.active) await this.stop(this.active.id, "quit");
      if (this.processing) await this.cancel(this.processing.id);
    } finally {
      this.closing = false;
    }
  }
  discard(id) {
    check(
      !this.busy(),
      "WORKSPACE_BUSY",
      "Stop capture and processing before deleting audio",
    );
    const store = this.catalog.store,
      record = store.get(scope(store), "recording", id);
    check(
      record.metadata.localCaptureVersion === 1,
      "INVALID_INPUT",
      "Not local capture",
    );
    const spool = new Spool(store, id).open();
    spool.purge(true);
    this.cleanScratch(spool);
    store.updateRecording(mutation(store, record.revision), id, {
      transcriptionState: record.transcriptionState === "complete" ? "complete" : "cancelled",
      metadata: {
        ...record.metadata,
        reason: "Audio deleted. Existing transcript text was kept.",
      },
    });
    this.emitChange();
  }
  // Records who a detected speaker is, then re-runs suggestion attribution for the
  // recording so untouched suggestions get real owners. Suggestions a person has
  // reviewed or edited keep their owner (store.attributeAction).
  async identifySpeaker(workspaceId, recordingId, speakerId, identity) {
    const store = this.catalog.scoped(workspaceId);
    const speaker = store.get(scope(store), "speaker", speakerId);
    check(speaker.recordingId === recordingId, "SCOPE_MISMATCH", "Speaker belongs to another recording");
    check(this.processing?.id !== recordingId, "WORKSPACE_BUSY", "This recording is still being processed");
    const updated = store.identifySpeaker(mutation(store, speaker.revision), speakerId, { identity });
    const record = store.get(scope(store), "recording", recordingId);
    let attribution = { skipped: "not-transcribed" };
    if (record.transcriptionState === "complete") {
      try {
        attribution = await require("../workspace/action-extraction").extractActions(store, recordingId, this.extractor);
      } catch (error) {
        attribution = { failed: true, reason: error.code ?? "FAILED" };
      }
    }
    this.emitChange();
    return { speaker: { id: updated.id, label: updated.label, identity: updated.identity }, attribution };
  }
  detail(workspaceId, id, offset = 0) {
    const store = this.catalog.scoped(workspaceId),
      record = store.get(scope(store), "recording", id);
    const transcript = store.list(scope(store), "transcript", {
      recordingId: id,
      limit: 100,
      offset,
    });
    const count = store._db
      .prepare(
        "SELECT count(*) AS count FROM transcript_segments WHERE recording_id=? AND deleted_at IS NULL",
      )
      .get(id).count;
    const link = store._db
      .prepare(
        "SELECT note_id FROM note_recordings JOIN notes ON notes.id=note_id WHERE recording_id=? AND note_recordings.deleted_at IS NULL AND notes.deleted_at IS NULL",
      )
      .get(id);
    let audio = { state: "unavailable", bytes: 0, overdue: false };
    if (record.metadata.localCaptureVersion === 1)
      try {
        const spool = new Spool(store, id).open();
        audio = {
          state:
            (spool.manifest.discarded || spool.manifest.purged) &&
            !spool.manifest.cleanupComplete
              ? "cleanup-pending"
              : spool.manifest.discarded
                ? "deleted"
                : spool.manifest.purged
                  ? "removed-after-transcription"
                  : record.keepAudio ? "retained" : "temporary",
          bytes: spool.manifest.cleanupComplete ? 0 : spool.manifest.bytes,
          overdue:
            !record.keepAudio &&
            !spool.manifest.purged &&
            !spool.manifest.discarded &&
            Date.now() - Date.parse(record.startedAt) > 86400000,
        };
      } catch {
        audio.state = "recovery-needed";
      }
    const speakerRows = store.list(scope(store), "speaker", { recordingId: id, limit: 1000 });
    // What a transcript row shows: "You", the person's name, or the detected label.
    const display = (speaker) =>
      speaker.identity?.kind === "self"
        ? "You"
        : speaker.identity?.kind === "person"
          ? speaker.identity.label
          : speaker.label;
    const speakers = new Map(speakerRows.map((speaker) => [speaker.id, display(speaker)]));
    return {
      recording: {
        ...publicRecording(record),
        processingError: record.metadata.processingError ?? null,
      },
      transcript: markEchoes(transcript).map(
        ({ id, source, text, startMs, endMs, speakerId, echoOf }) => ({
          id,
          source,
          text,
          startMs,
          endMs,
          speaker: speakers.get(speakerId) ?? null,
          echoOf,
        }),
      ),
      total: count,
      speakers: speakerRows.map((speaker) => ({
        id: speaker.id,
        label: speaker.label,
        identity: speaker.identity ?? { kind: "unknown", id: null, label: null },
        display: display(speaker),
      })),
      noteId: link?.note_id ?? null,
      audio,
    };
  }
}
module.exports = { RecordingService, publicRecording, markEchoes, requestId };
