"use strict";
// Speech engine benchmark (Apple speech and Parakeet).
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     qualification/speech/bench.cjs --engines apple,parakeet --fluidaudio <path>
// Results are cached per clip in qualification/speech/results/<engine>.jsonl.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
// Whisper was removed from the app on 2026-09-17 (D-06). Its results from the
// original run are recorded in docs/benchmarks/speech.md;
// they can no longer be regenerated from this checkout.

const ROOT = path.resolve(__dirname, "../..");
const DATA = path.join(__dirname, "data");
const RESULTS = path.join(__dirname, "results");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);


function timed(command, argv) {
  // /usr/bin/time -l reports peak resident memory for the child process.
  const started = process.hrtime.bigint();
  const result = spawnSync("/usr/bin/time", ["-l", command, ...argv], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const rss = Number(/(\d+)\s+maximum resident set size/.exec(result.stderr)?.[1] ?? 0);
  return { ...result, ms, rssMb: Math.round(rss / 1048576) };
}

const ENGINES = {
  parakeet: {
    languages: ["en"],
    run(item) {
      const cli = option("--fluidaudio", process.env.FLUIDAUDIO_CLI);
      if (!cli) throw new Error("Pass --fluidaudio <path to fluidaudiocli>");
      const r = timed(cli, ["transcribe", item.file]);
      if (r.status !== 0) throw new Error(`parakeet exit ${r.status}`);
      const text = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("[")).join(" ");
      return { text, ms: r.ms, rssMb: r.rssMb };
    },
  },
  apple: appleEngine({ en: "en-US", hi: "hi-IN", mixed: "hi-IN" }),
  // Indian English locale, for Indian-accented English and code-mixed speech.
  "apple-en-in": appleEngine({ en: "en-IN", mixed: "en-IN" }),
};
function appleEngine(locales) {
  return {
    languages: Object.keys(locales),
    run(item) {
      const locale = locales[item.lang];
      const r = timed(path.join(ROOT, "meeting-capture/bin/focusbae-transcribe"), [item.file, locale]);
      const out = JSON.parse(r.stdout.trim().split("\n").pop());
      if (!out.ok) throw new Error(`apple: ${out.error}`);
      return { text: out.text, ms: r.ms, rssMb: r.rssMb };
    },
  };
}
// ---- scoring --------------------------------------------------------------

const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + words(n % 100) : "");
  if (n < 1e6) return words(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + words(n % 1000) : "");
  return String(n);
}
// Fillers are dropped from both sides: meeting references transcribe them, and
// engines that omit them should not be charged for it.
const FILLERS = new Set(["uh", "um", "hmm", "mm", "mmhmm", "uhhuh", "ah", "er", "erm", "hm", "mhm", "huh"]);

function normalize(text, lang) {
  let t = (text || "").normalize("NFC").toLowerCase();
  if (lang === "en") {
    t = t.replace(/(\d+)%/g, "$1 percent").replace(/\$(\d+)/g, "$1 dollars");
    t = t.replace(/(\d),(\d{3})/g, "$1$2").replace(/\b\d{1,6}\b/g, (d) => words(Number(d)));
    t = t.replace(/[-‐]/g, "").replace(/[^a-z0-9' ]+/g, " ").replace(/'(?!\w)|(?<!\w)'/g, " ");
    return t.split(/\s+/).filter((w) => w && !FILLERS.has(w.replace(/'/g, "")));
  }
  return t.replace(/[\p{P}\p{S}।॥]+/gu, " ").split(/\s+/).filter(Boolean);
}

// Loose romanized key for Hindi, so Devanagari (Whisper, references) and Latin
// (Apple) output can be compared. Approximate by design: long/short vowels,
// aspiration, doubled letters and the inherent "a" are collapsed, because
// romanization writes them inconsistently ("achchi"/"acchi", "samay"/"samaya").
const DEVA = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
  "ं": "n", "ँ": "n", "ः": "h", "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j",
  "झ": "jh", "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh",
  "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "ड़": "d", "ढ़": "dh", "ज़": "z", "फ़": "f", "क्ष": "ksh", "ज्ञ": "gy",
};
function romanKey(text) {
  let latin = "";
  for (const ch of (text || "").normalize("NFC")) {
    if (ch === "्" || ch === "़") continue;
    latin += DEVA[ch] ?? ch;
  }
  return latin
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/w/g, "v").replace(/ph/g, "f").replace(/z/g, "j").replace(/q/g, "k").replace(/x/g, "ks")
    .replace(/([bcdfgjklmnpqrstvy])h/g, "$1")
    .replace(/a/g, "").replace(/[eiy]+/g, "i").replace(/[ou]+/g, "u")
    .replace(/(.)\1+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
}

function edits(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

// ---- runner ---------------------------------------------------------------

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "manifest.json"), "utf8"));
  const engines = option("--engines", Object.keys(ENGINES).join(",")).split(",");
  const sets = option("--sets", null)?.split(",");
  const limit = Number(option("--limit", "0"));
  fs.mkdirSync(RESULTS, { recursive: true });
  for (const engine of engines) {
    const spec = ENGINES[engine];
    if (!spec) throw new Error(`Unknown engine ${engine}`);
    const file = path.join(RESULTS, `${engine}.jsonl`);
    const done = new Map(
      fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [`${r.set}/${r.id}`, r])
        : [],
    );
    const perSet = {};
    for (const item of manifest) {
      if (sets && !sets.includes(item.set)) continue;
      if (!spec.languages.includes(item.lang)) continue;
      perSet[item.set] = (perSet[item.set] ?? 0) + 1;
      if (limit && perSet[item.set] > limit) continue;
      if (done.has(`${item.set}/${item.id}`)) continue;
      let record;
      try {
        const out = await spec.run({ ...item, file: path.join(DATA, item.wav) });
        record = { set: item.set, id: item.id, lang: item.lang, seconds: item.seconds, ...out };
      } catch (error) {
        record = { set: item.set, id: item.id, lang: item.lang, seconds: item.seconds, error: String(error.message).slice(0, 300) };
      }
      fs.appendFileSync(file, JSON.stringify(record) + "\n");
      process.stderr.write(`${engine} ${item.set}/${item.id} ${record.error ? "ERROR " + record.error : Math.round(record.ms) + "ms"}\n`);
    }
  }
  report(manifest);
}

function report(manifest) {
  const refs = new Map(manifest.map((m) => [`${m.set}/${m.id}`, m]));
  const rows = [];
  for (const name of fs.readdirSync(RESULTS).filter((n) => n.endsWith(".jsonl")).sort()) {
    const engine = name.slice(0, -6);
    const bySet = {};
    for (const line of fs.readFileSync(path.join(RESULTS, name), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      const ref = refs.get(`${r.set}/${r.id}`);
      if (!ref) continue;
      const s = (bySet[r.set] ??= { clips: 0, errors: 0, words: 0, wordEdits: 0, chars: 0, charEdits: 0, roman: 0, romanEdits: 0, keywords: 0, keywordHits: 0, audio: 0, ms: [], rss: 0, empty: 0 });
      s.clips++;
      if (r.error) {
        s.errors++;
        continue;
      }
      const a = normalize(ref.ref, ref.lang);
      const b = normalize(r.text, ref.lang);
      if (ref.lang !== "mixed") {
        s.words += a.length;
        s.wordEdits += edits(a, b);
        const ca = [...a.join("")], cb = [...b.join("")];
        s.chars += ca.length;
        s.charEdits += edits(ca, cb);
      }
      if (ref.keywords?.length) {
        const found = new Set((r.text || "").toLowerCase().match(/[a-z]+/g) ?? []);
        s.keywords += ref.keywords.length;
        s.keywordHits += ref.keywords.filter((k) => found.has(k)).length;
      }
      if (ref.lang !== "en") {
        const ra = [...romanKey(ref.ref).join("")], rb = [...romanKey(r.text).join("")];
        s.roman += ra.length;
        s.romanEdits += edits(ra, rb);
      }
      s.audio += r.seconds;
      s.ms.push(r.ms);
      s.rss = Math.max(s.rss, r.rssMb);
      if (!b.length) s.empty++;
    }
    for (const [set, s] of Object.entries(bySet)) {
      const sorted = [...s.ms].sort((x, y) => x - y);
      rows.push({
        set, engine, clips: s.clips, failed: s.errors, emptyOutput: s.empty,
        wer: s.words ? +(100 * s.wordEdits / s.words).toFixed(1) : null,
        cer: s.chars ? +(100 * s.charEdits / s.chars).toFixed(1) : null,
        romanCer: s.roman ? +(100 * s.romanEdits / s.roman).toFixed(1) : null,
        englishKeywords: s.keywords ? `${Math.round(100 * s.keywordHits / s.keywords)}%` : null,
        realtimeX: s.ms.length ? +(s.audio / (s.ms.reduce((x, y) => x + y, 0) / 1000)).toFixed(1) : null,
        medianClipMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
        peakMemoryMb: s.rss,
      });
    }
  }
  rows.sort((x, y) => x.set.localeCompare(y.set) || (x.wer ?? 999) - (y.wer ?? 999));
  fs.writeFileSync(path.join(RESULTS, "summary.json"), JSON.stringify(rows, null, 2));
  console.table(rows);
}

if (require.main === module) {
  if (args.includes("--report")) report(JSON.parse(fs.readFileSync(path.join(DATA, "manifest.json"), "utf8")));
  else main().catch((error) => { console.error(error); process.exit(1); });
}

module.exports = { normalize, edits, romanKey };
