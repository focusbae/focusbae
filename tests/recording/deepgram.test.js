"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DeepgramEngine } = require("../../recording/deepgram");
const { LocalPolicy } = require("../../privacy/local-policy");

const utterance = { pcm: Buffer.alloc(3200) };
function setup({ replies = [], connected = true } = {}) {
  const policy = new LocalPolicy();
  policy.setTeamConnected(connected);
  const calls = [];
  let tokens = 0, clock = 0;
  const engine = new DeepgramEngine({
    language: "mixed",
    policy,
    now: () => clock,
    token: async () => ({ accessToken: `t${++tokens}`, expiresAt: new Date(clock + 600000).toISOString() }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const reply = replies.shift() ?? { status: 200, body: { results: { channels: [{ alternatives: [{ transcript: "Deck Thursday tak bhej dungi" }] }] } } };
      return { ok: reply.status === 200, status: reply.status, json: async () => reply.body ?? {} };
    },
  });
  return { engine, policy, calls, advance: (ms) => { clock += ms; } };
}

test("sends a WAV with a short-lived token, opted out of training, in multilingual mode for mixed speech", async () => {
  const { engine, calls } = setup();
  await engine.load();
  assert.deepEqual(await engine.transcribe(utterance), { content: "Deck Thursday tak bhej dungi" });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
  assert.deepEqual(Object.fromEntries(url.searchParams), { model: "nova-3", smart_format: "true", language: "multi", mip_opt_out: "true" });
  assert.equal(calls[0].init.headers.authorization, "Bearer t1");
  assert.equal(calls[0].init.body.toString("ascii", 0, 4), "RIFF");
  assert.equal(calls[0].init.body.length, 44 + 3200);
});

test("renews the token before it expires, and once if Deepgram rejects it", async () => {
  const { engine, calls, advance } = setup({ replies: [{ status: 200 }, { status: 401 }, { status: 200 }] });
  await engine.load();
  await engine.transcribe(utterance);
  advance(560000); // within a minute of expiry
  await engine.transcribe(utterance);
  assert.deepEqual(calls.map((c) => c.init.headers.authorization), ["Bearer t1", "Bearer t2", "Bearer t3"]);
});

test("sends nothing when the team network is off, or turns off mid-recording", async () => {
  const off = setup({ connected: false });
  await assert.rejects(off.engine.load(), { code: "POLICY_DENIED" });
  await assert.rejects(off.engine.transcribe(utterance), { code: "POLICY_DENIED" });
  assert.equal(off.calls.length, 0);
  const strict = setup();
  await strict.engine.load();
  strict.policy.setStrict(true);
  await assert.rejects(strict.engine.transcribe(utterance), { code: "POLICY_DENIED" });
  assert.equal(strict.calls.length, 0);
});

test("reports a failed transcription instead of returning empty text", async () => {
  const { engine } = setup({ replies: [{ status: 400 }] });
  await engine.load();
  await assert.rejects(engine.transcribe(utterance), { code: "TRANSCRIPTION_FAILED" });
});
