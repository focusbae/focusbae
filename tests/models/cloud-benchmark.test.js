"use strict";
// The level 2 and 3 benchmark adapters, against faked provider responses: requests are
// shaped as each API expects and answers are read back correctly, before any key is used.
const test = require("node:test");
const assert = require("node:assert/strict");

function fakeFetch(t, reply) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => reply(String(url), init) };
  };
  t.after(() => { global.fetch = real; });
  return calls;
}

const meeting = {
  accountOwner: "Me",
  segments: [{ id: "s1", speaker: "Priya", text: "I'll send the deck on Friday." }],
};

test("Claude gets the on-device prompt and must answer through the commitments tool", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const calls = fakeFetch(t, () => ({
    content: [{ type: "tool_use", name: "report_commitments", input: { commitments: [{ segmentId: "s1", quote: "I'll send the deck on Friday", owner: "other", person: "Priya" }] } }],
    usage: { input_tokens: 120, output_tokens: 30 },
  }));
  const cloud = require("../../qualification/extraction/cloud");
  const totals = { input: 0, output: 0, model: null };
  const found = await cloud.extract("anthropic", meeting, totals);
  assert.deepEqual(found, [{ segmentId: "s1", quote: "I'll send the deck on Friday", owner: "other", person: "Priya" }]);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "report_commitments" });
  assert.match(body.messages[0].content, /\[s1\] Priya: I'll send the deck on Friday\./);
  assert.equal(body.system, cloud.INSTRUCTIONS);
  assert.deepEqual([totals.input, totals.output], [120, 30]);
});

test("OpenAI is asked for a strict JSON schema, with the model named in the environment", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  const calls = fakeFetch(t, () => ({
    choices: [{ message: { content: JSON.stringify({ commitments: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }));
  const cloud = require("../../qualification/extraction/cloud");
  assert.deepEqual(await cloud.extract("openai", meeting), []);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.response_format.json_schema.strict, true);
});

test("Deepgram and ElevenLabs are sent the clip and their transcripts read back", async (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fb-bench-")), "clip.wav");
  fs.writeFileSync(file, Buffer.from("RIFF"));
  process.env.DEEPGRAM_API_KEY = "dg"; process.env.ELEVENLABS_API_KEY = "el";
  const calls = fakeFetch(t, (url) => url.includes("deepgram")
    ? { results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] } }
    : { text: "hello there" });
  const { ENGINES } = require("../../qualification/speech/bench.cjs");
  assert.equal((await ENGINES.deepgram.run({ file, lang: "en" })).text, "hello there");
  assert.equal((await ENGINES.elevenlabs.run({ file, lang: "mixed" })).text, "hello there");
  assert.match(calls[0].url, /model=nova-3&smart_format=true&language=en$/);
  assert.equal(calls[0].init.headers.authorization, "Token dg");
  assert.equal(calls[1].init.headers["xi-api-key"], "el");
  assert.equal(calls[1].init.body.get("language_code"), null, "code-mixed speech is left to detection");
});
