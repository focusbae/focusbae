"use strict";
// Processing level 2 (TEAM_PLAN §3): commitments found in transcript text by OpenAI,
// through the team service (OpenAI has no short-lived client tokens; the service relays
// without storing). Same interface as the on-device model (local-ai/extraction-runtime),
// so workspace/action-extraction.js treats both alike; suggestions are marked as cloud.
const { check } = require("../workspace/errors");

// A request carries part of one transcript; the service accepts up to 60,000 characters.
const BATCH_CHARS = 40000;
const BATCH_SEGMENTS = 300;

function batches(segments) {
  const out = [];
  let batch = [], size = 0;
  for (const segment of segments) {
    if (batch.length && (size + segment.text.length > BATCH_CHARS || batch.length >= BATCH_SEGMENTS)) {
      out.push(batch);
      batch = []; size = 0;
    }
    batch.push({ id: segment.id, speaker: segment.speaker ?? null, text: segment.text.slice(0, 8000) });
    size += segment.text.length;
  }
  if (batch.length) out.push(batch);
  return out;
}

class CloudExtractor {
  constructor({ account, workspace, policy }) {
    Object.assign(this, { account, workspace, policy, origin: "cloud-model" });
  }

  async extract({ owner, segments }) {
    check(Array.isArray(segments), "INVALID_INPUT", "Invalid extraction request");
    const found = [];
    for (const batch of batches(segments)) {
      this.policy.assert("team");
      found.push(...(await this.account.extract(this.workspace, { owner, segments: batch })));
    }
    return found;
  }
}

module.exports = { CloudExtractor, batches };
