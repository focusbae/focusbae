"use strict";
// Processing level 3 (TEAM_PLAN §3): cloud transcription with Deepgram Nova-3, chosen
// after the English benchmark (docs/strategy/BENCHMARK_2026-10-21.md). Used only for a
// recording in a team workspace whose admin allows level 3 and whose person chose cloud
// transcription for it, while the team account is connected and Strict Local is off.
//
// Same contract as the on-device engines (recording/speech.js): one utterance in, its
// text out, so resuming, segments, speakers and extraction work unchanged. The token is
// short-lived and comes from the team service per recording; audio goes from this Mac
// to Deepgram directly and Deepgram is told not to use it for training.
const { check } = require("../workspace/errors");
const { wavHeader } = require("./diarize");

const MODEL = "nova-3";
// Recording languages to Deepgram's: Hinglish and other mixed speech use its
// multilingual mode rather than forcing one language.
const LANGUAGES = { english: "en", hindi: "hi", mixed: "multi" };
// Refresh a token this long before it expires, so a request never carries a stale one.
const MARGIN_MS = 60 * 1000;

class DeepgramEngine {
  constructor({ language, token, policy, fetchImpl = fetch, now = () => Date.now() }) {
    check(LANGUAGES[language], "INVALID_INPUT", "Unsupported language");
    Object.assign(this, { language, token, policy, fetch: fetchImpl, now, engine: "deepgram", model: MODEL, grant: null });
  }

  async access() {
    if (!this.grant || Date.parse(this.grant.expiresAt) - MARGIN_MS <= this.now()) this.grant = await this.token();
    return this.grant.accessToken;
  }

  async load() {
    this.policy.assert("team");
    await this.access();
  }

  async transcribe(utterance) {
    const pcm = Buffer.from(utterance.pcm);
    check(pcm.length > 0 && pcm.length <= 900000 && pcm.length % 2 === 0, "INVALID_AUDIO", "Invalid speech audio");
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const query = new URLSearchParams({ model: MODEL, smart_format: "true", language: LANGUAGES[this.language], mip_opt_out: "true" });
    let response;
    for (let attempt = 0; ; attempt++) {
      // Strict Local or a sign-out during a recording stops the next request.
      this.policy.assert("team", ticket);
      response = await this.fetch(`https://api.deepgram.com/v1/listen?${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.access()}`, "content-type": "audio/wav" },
        body: Buffer.concat([wavHeader(pcm.length), pcm]),
      });
      if (response.status === 401 && attempt === 0) { this.grant = null; continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      break;
    }
    check(response.ok, "TRANSCRIPTION_FAILED", `Cloud transcription failed (${response.status})`);
    const body = await response.json();
    return { content: body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "" };
  }

  dispose() {
    this.grant = null;
  }
}

module.exports = { DeepgramEngine, LANGUAGES, MODEL };
