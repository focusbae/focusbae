"use strict";
// Rewriting a passage with the on-device model. The model is not run here — what
// is tested is everything around it, which is where a rewrite can do harm: losing
// a number, accepting an empty answer, or rewriting when nothing is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExtractionRuntime } = require("../../local-ai/extraction-runtime");

// A stand-in helper: prints whatever answer the test wants, the way the real one does.
function helper(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-rewrite-"));
  const file = path.join(dir, "helper");
  fs.writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ExtractionRuntime({ binary: file, timeoutMs: 10000 });
}
const says = (t, json) => helper(t, `echo '${json}'`);

test("numbers are compared by value, not by how they are written", () => {
  assert.deepEqual(ExtractionRuntime.numbers("budget of 40,000 on 2026-09-21"), [
    "09",
    "2026",
    "21",
    "40000",
  ]);
  assert.deepEqual(
    ExtractionRuntime.numbers("budget of 40000 on 2026-09-21"),
    ExtractionRuntime.numbers("budget of 40,000 on 2026-09-21"),
    "adding a thousands separator is not a change of fact",
  );
  assert.deepEqual(ExtractionRuntime.numbers("nothing numeric here"), []);
});

test("a rewrite that drops a number is refused, and the words are kept", async (t) => {
  const runtime = says(t, '{"ok":true,"text":"I will send the budget to Raghav on Friday."}');
  await assert.rejects(
    () =>
      runtime.rewrite({
        style: "shorten",
        text: "I will send the revised budget of 40000 to Raghav on Friday.",
      }),
    { code: "REWRITE_UNSAFE" },
  );
  // The same answer is fine when the number survives, however it is punctuated.
  const kept = says(t, '{"ok":true,"text":"I will send the 40,000 budget to Raghav on Friday."}');
  assert.equal(
    await kept.rewrite({
      style: "shorten",
      text: "I will send the revised budget of 40000 to Raghav on Friday.",
    }),
    "I will send the 40,000 budget to Raghav on Friday.",
  );
});

test("an empty or malformed answer is a failure, not a passage that vanishes", async (t) => {
  for (const [json, code] of [
    ['{"ok":true,"text":"   "}', "MODEL_INVALID"],
    ['{"ok":true}', "MODEL_INVALID"],
    ['{"ok":false,"code":"FAILED"}', "MODEL_INVALID"],
    ['not json at all', "MODEL_INVALID"],
  ])
    await assert.rejects(
      () => says(t, json).rewrite({ style: "tidy", text: "Some writing." }),
      { code },
      json,
    );
});

test("rewriting says so plainly when this Mac cannot do it", async (t) => {
  const missing = new ExtractionRuntime({
    binary: path.join(os.tmpdir(), "focusbae-absent-helper"),
  });
  await assert.rejects(() => missing.rewrite({ style: "tidy", text: "Some writing." }), {
    code: "REWRITE_UNAVAILABLE",
  });
  await assert.rejects(
    () => says(t, '{"ok":false,"code":"UNAVAILABLE"}').rewrite({ style: "tidy", text: "x" }),
    { code: "REWRITE_UNAVAILABLE" },
    "Apple Intelligence turned off is the same answer as no helper at all",
  );
  // Extraction keeps its own wording, because its fallback is different.
  await assert.rejects(() => missing.extract({ owner: "You", segments: [{ id: "s1", text: "x" }] }), {
    code: "MODEL_MISSING",
  });
});

test("the request is bounded before the model ever sees it", async (t) => {
  const runtime = says(t, '{"ok":true,"text":"fine"}');
  for (const input of [
    { style: "embellish", text: "Some writing." },
    { style: "tidy", text: "   " },
    { style: "tidy", text: "" },
    { style: "tidy", text: "x".repeat(8001) },
    { style: "tidy", text: 42 },
  ])
    await assert.rejects(() => runtime.rewrite(input), { code: "INVALID_INPUT" }, JSON.stringify(input.style));
  assert.equal(await runtime.rewrite({ style: "proofread", text: "x".repeat(8000) }), "fine");
});
