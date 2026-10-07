/**
 * Segmenter tests. Run with: node meeting-capture/segmenter.test.js
 *
 * No test runner in this app, so this is a plain script that exits non-zero on
 * failure -- enough to be wired into CI later without adding a dependency.
 *
 * Signals are synthesised rather than recorded so the expected segmentation is
 * known exactly. The cases that matter are the ones where naive VAD gets it wrong:
 * a pause inside a sentence, a noisy room, and sub-second noise that a recognizer would
 * otherwise hallucinate words out of.
 */
const assert = require("assert");
const { Segmenter, SAMPLE_RATE, FRAME_MS, ABSOLUTE_FLOOR } = require("./segmenter");

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** Signed-16 PCM of `ms` milliseconds at a given RMS amplitude. */
function tone(ms, amplitude) {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Square-ish alternation gives RMS ~= amplitude exactly, which keeps the
    // thresholds in these tests unambiguous.
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

const silence = (ms) => tone(ms, 0);
const roomTone = (ms) => tone(ms, 120); // below ABSOLUTE_FLOOR
const speech = (ms) => tone(ms, 4000);

function collect(chunks, opts = {}) {
  const out = [];
  const seg = new Segmenter({
    speaker: "user",
    onUtterance: (u) => out.push(u),
    ...opts,
  });
  for (const c of chunks) seg.push(c);
  seg.end();
  return out;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("emits one utterance for one continuous phrase", () => {
  const out = collect([silence(300), speech(1500), silence(1200)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].speaker, "user");
});

test("does not split on a pause inside a sentence", () => {
  // 300ms is a normal sentence-internal breath. Splitting here would separate
  // "I'll send you the deck" from "by Thursday" and lose the deadline.
  const out = collect([speech(900), silence(300), speech(900), silence(1200)]);
  assert.strictEqual(out.length, 1);
});

test("splits on a real turn boundary", () => {
  const out = collect([speech(900), silence(1200), speech(900), silence(1200)]);
  assert.strictEqual(out.length, 2);
});

test("keeps mid-utterance silence in the audio", () => {
  // Splicing the pause out would run words together and change what the recognizer hears.
  const out = collect([speech(600), silence(300), speech(600), silence(1200)]);
  assert.strictEqual(out.length, 1);
  const durationMs = out[0].pcm.length / BYTES_PER_MS;
  assert.ok(durationMs >= 1400, `expected pause retained, got ${durationMs}ms`);
});

test("drops sub-second noise instead of transcribing it", () => {
  // Recognizers (Whisper especially) invent text ("Thank you.", "Bye.") out of clicks and
  // breaths, which then become fabricated transcript lines.
  const out = collect([silence(300), speech(150), silence(1200)]);
  assert.strictEqual(out.length, 0);
});

test("ignores room tone below the absolute floor", () => {
  const out = collect([roomTone(3000)]);
  assert.strictEqual(out.length, 0);
});

test("still detects speech over a noisy background", () => {
  // A laptop fan or cafe. The adaptive floor should settle onto the noise and
  // speech should still clear it -- a fixed threshold tuned for a quiet room
  // either misses this speech or fires constantly on the noise.
  const noisy = tone(4000, 500);
  const out = collect([noisy, tone(1500, 6000), noisy]);
  assert.ok(out.length >= 1, "speech over background noise was missed");
});

test("force-flushes a monologue rather than buffering forever", () => {
  const out = collect([speech(9000), silence(1200)], { maxUtteranceMs: 3000 });
  assert.ok(out.length >= 3, `expected periodic flushes, got ${out.length}`);
});

test("does not go deaf during a long monologue", () => {
  // Regression. When the noise floor adapted on every frame, sustained speech
  // dragged it up until the threshold exceeded the speaker's own level and
  // detection died -- measured at ~3.6s, well inside a normal turn, so the back
  // half of every long explanation vanished. The floor now only adapts on frames
  // already classified as silence.
  const seg = new Segmenter({ speaker: "user", onUtterance: () => {} });
  seg.push(speech(30000));
  const floorAfter = seg.noiseFloor;
  assert.ok(
    floorAfter <= ABSOLUTE_FLOOR,
    `speech lifted the noise floor to ${floorAfter}; it must stay at or below ${ABSOLUTE_FLOOR}`
  );
});

test("end() emits audio still buffered when the meeting stops", () => {
  // No trailing silence: the user hit stop mid-sentence.
  const out = collect([silence(300), speech(1500)]);
  assert.strictEqual(out.length, 1);
});

test("timestamps advance monotonically across utterances", () => {
  const out = collect([
    speech(800), silence(1200),
    speech(800), silence(1200),
    speech(800), silence(1200),
  ]);
  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      out[i].startMs >= out[i - 1].endMs,
      `utterance ${i} starts at ${out[i].startMs} before previous ended at ${out[i - 1].endMs}`
    );
  }
});

test("handles chunk boundaries that split a frame", () => {
  // audiotee emits 200ms chunks; nothing guarantees they align to 20ms frames
  // once resampling is involved. A dropped remainder would desynchronise every
  // timestamp after it.
  const long = speech(2000);
  const odd = [];
  for (let i = 0; i < long.length; i += 333) odd.push(long.subarray(i, i + 333));
  const out = collect([...odd, silence(1200)]);
  assert.strictEqual(out.length, 1);
});

test("empty and null pushes are harmless", () => {
  const seg = new Segmenter({ speaker: "user", onUtterance: () => {} });
  seg.push(null);
  seg.push(Buffer.alloc(0));
  seg.end();
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
