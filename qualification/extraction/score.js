"use strict";
// Extraction quality harness. Scores an extractor against labelled transcripts:
// commitment precision/recall and, for matched commitments, owner accuracy.
// Usage: node qualification/extraction/score.js [--extractor rules] [--gold dir] [--json]

const fs = require("node:fs");
const path = require("node:path");

const BINARY = path.join(__dirname, "../../local-ai/bin/focusbae-extract");

const EXTRACTORS = {
  // Current production baseline: workspace/action-extraction.js. It never
  // resolves ownership, so every prediction is owner "unknown".
  rules: async (meeting) => {
    const { candidates } = require("../../workspace/action-extraction");
    return meeting.segments.flatMap((segment) =>
      candidates({ id: segment.id, revision: 1, text: segment.text }).map(
        (item) => ({
          segmentId: segment.id,
          quote: item.evidence[0].quote,
          owner: "unknown",
        }),
      ),
    );
  },
  // What the app actually sends today: anonymous speaker labels and no known owner.
  "apple-anonymous": async (meeting) => {
    const names = new Map();
    const segments = meeting.segments.map((segment) => {
      if (segment.speaker && !names.has(segment.speaker)) names.set(segment.speaker, `Speaker ${names.size + 1} · Mac audio`);
      return { ...segment, speaker: segment.speaker ? names.get(segment.speaker) : null };
    });
    const found = await EXTRACTORS.apple({
      ...meeting,
      accountOwner: "the account owner (not yet identified among the speakers)",
      segments,
    });
    // The app stores every model proposal with an unknown owner until the user identifies themselves.
    return found.map((item) => ({ ...item, owner: "unknown" }));
  },
  // After "This is me": the account owner's speaker is "You", everyone else is an
  // anonymous detected speaker. Owners map self->self, a named person->other.
  "apple-me": async (meeting) => {
    const owner = meeting.accountOwner ?? "Me";
    const names = new Map();
    const segments = meeting.segments.map((segment) => {
      if (!segment.speaker) return { ...segment, speaker: null };
      if (segment.speaker === owner) return { ...segment, speaker: "You" };
      if (!names.has(segment.speaker)) names.set(segment.speaker, `Speaker ${names.size + 1}`);
      return { ...segment, speaker: names.get(segment.speaker) };
    });
    const found = await EXTRACTORS.apple({ ...meeting, accountOwner: "You", segments }, { raw: true });
    return found.map((item) => ({ ...item, owner: ownerFor(item, segments) }));
  },
  // Apple Foundation Models on-device (macOS 26+, Apple Intelligence enabled).
  // Build first with: bash local-ai/apple-extract/build.sh
  apple: async (meeting, { raw = false } = {}) => {
    const { execFileSync } = require("node:child_process");
    if (!fs.existsSync(BINARY)) throw new Error("Build local-ai/apple-extract first");
    const input = JSON.stringify({ owner: meeting.accountOwner ?? "Me", segments: meeting.segments });
    let stdout;
    try {
      stdout = execFileSync(BINARY, { input, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      stdout = error.stdout;
    }
    const result = JSON.parse(String(stdout));
    if (!result.ok) throw new Error(`apple extractor: ${result.code} ${result.error ?? ""}`);
    const found = result.commitments.map(({ segmentId, quote, owner, person }) => ({ segmentId, quote, owner, person }));
    if (raw) return found;
    return found.map((item) => ({ ...item, owner: ownerFor(item, meeting.segments, meeting.accountOwner ?? "Me") }));
  },
};

// Applies the app's owner resolution (workspace/action-extraction.js resolveOwner)
// using the speaker labels this transcript provides.
function ownerFor(item, segments, self = "You") {
  const { resolveOwner } = require("../../workspace/action-extraction");
  const speaker = segments.find((segment) => segment.id === item.segmentId)?.speaker ?? null;
  const role = speaker === null ? "unknown" : speaker === self ? "self" : "other";
  const resolved = resolveOwner({
    quote: item.quote,
    speaker: { role, name: role === "other" && !/^Speaker \d/.test(speaker) ? speaker : null },
    modelOwner: item.owner,
    modelPerson: item.person,
  });
  return resolved.kind;
}

const norm = (text) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// A prediction matches a labelled commitment when it cites the same segment and
// either quote contains the other (sentence splitting differs between extractors).
function matches(prediction, expected) {
  if (prediction.segmentId !== expected.segmentId) return false;
  const a = norm(prediction.quote);
  const b = norm(expected.quote);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

function load(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const meeting = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      for (const key of ["id", "source", "segments", "commitments"])
        if (!(key in meeting)) throw new Error(`${name}: missing ${key}`);
      const ids = new Set(meeting.segments.map((segment) => segment.id));
      for (const item of meeting.commitments) {
        if (!ids.has(item.segmentId)) throw new Error(`${name}: unknown segment ${item.segmentId}`);
        if (!["self", "other", "unknown"].includes(item.owner))
          throw new Error(`${name}: invalid owner ${item.owner}`);
        const text = meeting.segments.find((s) => s.id === item.segmentId).text;
        if (!norm(text).includes(norm(item.quote)))
          throw new Error(`${name}: quote not found verbatim in ${item.segmentId}`);
      }
      return meeting;
    });
}

async function score(meetings, extract) {
  const totals = { predicted: 0, expected: 0, truePositive: 0, ownerCorrect: 0, meetings: [] };
  for (const meeting of meetings) {
    const predictions = await extract(meeting);
    const used = new Set();
    const misses = [];
    let tp = 0;
    let ownerCorrect = 0;
    for (const expected of meeting.commitments) {
      const index = predictions.findIndex((p, i) => !used.has(i) && matches(p, expected));
      if (index < 0) {
        misses.push(expected.quote);
        continue;
      }
      used.add(index);
      tp++;
      if (predictions[index].owner === expected.owner) ownerCorrect++;
    }
    const falsePositives = predictions.filter((_, i) => !used.has(i)).map((p) => p.quote);
    totals.predicted += predictions.length;
    totals.expected += meeting.commitments.length;
    totals.truePositive += tp;
    totals.ownerCorrect += ownerCorrect;
    totals.meetings.push({ id: meeting.id, source: meeting.source, predicted: predictions.length,
      expected: meeting.commitments.length, truePositive: tp, ownerCorrect, misses, falsePositives });
  }
  const ratio = (a, b) => (b ? a / b : null);
  return {
    ...totals,
    precision: ratio(totals.truePositive, totals.predicted),
    recall: ratio(totals.truePositive, totals.expected),
    ownerAccuracy: ratio(totals.ownerCorrect, totals.truePositive),
    // Owner-correct commitments over all labelled ones: the number the ledger lives on.
    endToEnd: ratio(totals.ownerCorrect, totals.expected),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const name = option("--extractor", "rules");
  const extract = EXTRACTORS[name];
  if (!extract) throw new Error(`Unknown extractor ${name}; available: ${Object.keys(EXTRACTORS).join(", ")}`);
  const meetings = load(path.resolve(option("--gold", path.join(__dirname, "gold"))));
  const result = await score(meetings, extract);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ extractor: name, ...result }, null, 2));
    return;
  }
  const pct = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(0)}%`);
  const sources = [...new Set(meetings.map((m) => m.source))].join(", ");
  console.log(`extractor ${name} · ${meetings.length} transcripts (${sources})`);
  console.log(`precision ${pct(result.precision)} (${result.truePositive}/${result.predicted})`);
  console.log(`recall    ${pct(result.recall)} (${result.truePositive}/${result.expected})`);
  console.log(`owner     ${pct(result.ownerAccuracy)} of matched (${result.ownerCorrect}/${result.truePositive})`);
  console.log(`end-to-end ${pct(result.endToEnd)} of labelled commitments found with the right owner`);
  for (const m of result.meetings) {
    for (const quote of m.misses) console.log(`  miss  [${m.id}] ${quote}`);
    for (const quote of m.falsePositives) console.log(`  false [${m.id}] ${quote}`);
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });

module.exports = { EXTRACTORS, load, matches, score };
