"use strict";
const { EventEmitter } = require("node:events");
const { check } = require("../workspace/errors");
const { SpeechRouter } = require("./speech");

// Local model capabilities for the workspace: speech (Apple built in, optional
// Parakeet), speaker detection, action suggestions and semantic search. Probes
// launch helpers, so they run only on refresh (when model settings open) or
// before processing, never when a snapshot is taken.
class ModelManager extends EventEmitter {
  constructor({
    speech = new SpeechRouter(),
    inUse = () => false,
    embedding = null,
    extraction = null,
    diarization = null,
  } = {}) {
    super();
    Object.assign(this, { speech, inUse, embedding, extraction, diarization });
    this.capabilities = {
      generation: { status: "checking", ready: false },
      embedding: { status: "checking", ready: false },
    };
    this.onChange = () => this.emit("change");
    for (const source of [speech.apple, speech.parakeet, diarization]) source?.on("change", this.onChange);
  }
  initialize() {
    // Hash verification of installed models; reads files only, launches nothing.
    this.speech.parakeet?.verify();
    this.diarization?.verify();
  }
  async refresh() {
    const [generation, embedding] = await Promise.all([
      this.generationState(),
      this.embeddingState(),
      this.speech.apple?.refresh(),
    ]);
    this.capabilities = { generation, embedding };
    this.emit("change");
    return this.snapshot();
  }
  async generationState() {
    if (!this.extraction) return { status: "unavailable", ready: false, reason: "MODEL_MISSING" };
    const status = await this.extraction.status();
    return status.available
      ? { status: "ready", ready: true, engine: "apple-foundation-models", fallback: "local-rule" }
      : { status: "unavailable", ready: false, reason: status.reason, fallback: "local-rule" };
  }
  async embeddingState() {
    if (!this.embedding) return { status: "unavailable", ready: false, reason: "MODEL_MISSING" };
    const status = await this.embedding.status();
    return status.available
      ? { status: "ready", ready: true, profile: status.profile, dimensions: status.dimensions, language: status.language }
      : { status: "unavailable", ready: false, reason: status.reason ?? null };
  }
  snapshot() {
    const route = this.speech.state("english");
    return {
      speech: {
        ...route,
        inUse: this.inUse(),
        apple: this.speech.apple?.state() ?? { supported: false, probed: false, locales: {} },
        parakeet: this.speech.parakeet?.state() ?? { status: "unsupported", ready: false },
      },
      generation: this.capabilities.generation,
      embedding: this.capabilities.embedding,
      diarization: this.diarization?.state() ?? { status: "unsupported", ready: false },
    };
  }
  guard() {
    check(!this.inUse(), "WORKSPACE_BUSY", "Speech processing is active");
  }
  start(kind) {
    this.guard();
    const target = kind === "parakeet" ? this.speech.parakeet : kind === "speakers" ? this.diarization : null;
    check(target, "MODEL_INCOMPATIBLE", "This model is unavailable");
    target.download().catch(() => {});
    return this.snapshot();
  }
  importModel(kind, folder) {
    this.guard();
    const target = kind === "parakeet" ? this.speech.parakeet : kind === "speakers" ? this.diarization : null;
    check(target, "MODEL_INCOMPATIBLE", "This model is unavailable");
    target.importFrom(folder).catch(() => {});
    return this.snapshot();
  }
  installLanguage(locale) {
    this.guard();
    check(this.speech.apple, "MODEL_INCOMPATIBLE", "Apple speech is unavailable");
    this.speech.apple.install(locale).catch(() => {});
    return this.snapshot();
  }
  async close() {
    for (const source of [this.speech.apple, this.speech.parakeet, this.diarization]) source?.removeListener("change", this.onChange);
  }
}
module.exports = { ModelManager };
