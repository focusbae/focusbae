#!/usr/bin/env python3
"""Downloads and prepares the speech benchmark sets into qualification/speech/data.

Sets (all CC-BY-4.0, attribution in README.md):
  ami-headset   AMI meeting corpus, close-talk headset mix, 4 meetings
  ami-farfield  AMI meeting corpus, table-top array microphone 1, 2 meetings
  libri-clean   LibriSpeech test-clean read speech
  fleurs-hi     FLEURS Hindi (dev split) read speech
  edacc-*       EdAcc conversational English by accent group (CC BY-SA 4.0)

Clips are cut at pauses so no reference word is split. Standard library only;
FLAC is converted with macOS afconvert.
"""
import csv, io, json, os, random, re, subprocess, sys, tarfile, time, urllib.error, urllib.request, wave, zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(DATA, "raw")
CLIPS = os.path.join(DATA, "clips")
AMI_MIRROR = "https://huggingface.co/datasets/FluidInference/ami-corpus-mirror/resolve/main"
AMI_UPSTREAM = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus"
HEADSET_MEETINGS = ["ES2004a", "IS1009a", "TS3003a", "EN2002a"]
FARFIELD_MEETINGS = ["ES2004a", "IS1009a"]
CLIPS_PER_MEETING = 12
LIBRI_UTTERANCES = 40
FLEURS_UTTERANCES = 40
EDACC_ROWS = "https://datasets-server.huggingface.co/rows?dataset=edinburghcstr/edacc&config=default&split=test"
EDACC_PER_GROUP = 15
# EdAcc's accent labels grouped the way customers differ: where English is spoken as a
# first language, and the first languages of second-language speakers.
EDACC_GROUPS = {
    "indian": ["Indian English"],
    "us": ["Mainstream US English"],
    "uk-ireland": ["Southern British English", "Scottish English", "Irish English"],
    "african": ["Nigerian English", "Kenyan English", "Ghanain English"],
    "caribbean": ["Jamaican English"],
    "european-l2": ["Spanish", "Italian", "Romanian", "Lithuanian", "Catalan", "French", "Bulgarian", "European", "Eastern European", "Israeli"],
    "asian-l2": ["Chinese", "Vietnamese", "Indonesian"],
}


def fetch(url, target):
    if os.path.exists(target):
        return target
    os.makedirs(os.path.dirname(target), exist_ok=True)
    print(f"downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as response, open(target + ".part", "wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    os.replace(target + ".part", target)
    return target


def ami_words(zip_path, meeting):
    words = []
    with zipfile.ZipFile(zip_path) as archive:
        for name in archive.namelist():
            if not re.search(rf"words/{meeting}\.[A-Z]\.words\.xml$", name):
                continue
            speaker = name.split(".")[-3]
            root = ET.fromstring(archive.read(name))
            for element in root.iter():
                if not element.tag.endswith("w") or element.get("punc") == "true":
                    continue
                if element.get("starttime") is None or not (element.text or "").strip():
                    continue
                words.append((float(element.get("starttime")), float(element.get("endtime")), element.text.strip(), speaker))
    return sorted(words)


def ami_windows(words, count, target=20.0, minimum=12.0, maximum=30.0, gap=0.4):
    """Picks non-overlapping windows that start and end in pauses."""
    boundaries = [i for i in range(1, len(words)) if words[i][0] - words[i - 1][1] >= gap]
    windows, cursor = [], 0
    span = words[-1][1] - words[0][0]
    anchors = [words[0][0] + 60 + k * (span - 120) / count for k in range(count)]
    for anchor in anchors:
        starts = [b for b in boundaries if words[b][0] >= anchor and b >= cursor]
        if not starts:
            continue
        start = starts[0]
        ends = [b for b in boundaries if b > start and minimum <= words[b - 1][1] - words[start][0] <= maximum]
        if not ends:
            continue
        end = min(ends, key=lambda b: abs(words[b - 1][1] - words[start][0] - target))
        chosen = words[start:end]
        if len(chosen) >= 15:
            windows.append(chosen)
            cursor = end
    return windows


def slice_wav(source, target, start_s, end_s):
    with wave.open(source) as w:
        assert w.getframerate() == 16000 and w.getsampwidth() == 2, source
        channels = w.getnchannels()
        w.setpos(int(start_s * 16000))
        frames = w.readframes(int((end_s - start_s) * 16000))
    if channels > 1:  # keep the first channel
        frames = b"".join(frames[i:i + 2] for i in range(0, len(frames), 2 * channels))
    with wave.open(target, "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
        out.writeframes(frames)


def to_wav(source, target):
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", source, target], check=True)


def prepare_ami(items, annotations):
    for kind, meetings in (("ami-headset", HEADSET_MEETINGS), ("ami-farfield", FARFIELD_MEETINGS)):
        for meeting in meetings:
            if kind == "ami-headset":
                audio = fetch(f"{AMI_MIRROR}/sdm/{meeting}.Mix-Headset.wav", os.path.join(RAW, f"{meeting}.Mix-Headset.wav"))
            else:
                audio = fetch(f"{AMI_UPSTREAM}/{meeting}/audio/{meeting}.Array1-01.wav", os.path.join(RAW, f"{meeting}.Array1-01.wav"))
            for n, window in enumerate(ami_windows(ami_words(annotations, meeting), CLIPS_PER_MEETING)):
                start, end = max(0.0, window[0][0] - 0.2), window[-1][1] + 0.2
                clip = os.path.join(CLIPS, kind, f"{meeting}-{n:02d}.wav")
                os.makedirs(os.path.dirname(clip), exist_ok=True)
                slice_wav(audio, clip, start, end)
                items.append({"set": kind, "id": f"{meeting}-{n:02d}", "lang": "en", "wav": clip,
                              "ref": " ".join(w[2] for w in window), "seconds": round(end - start, 2),
                              "speakers": len({w[3] for w in window})})


def prepare_libri(items):
    archive = fetch("https://www.openslr.org/resources/12/test-clean.tar.gz", os.path.join(RAW, "libri-test-clean.tar.gz"))
    texts, flacs = {}, {}
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            if member.name.endswith(".trans.txt"):
                for line in tar.extractfile(member).read().decode().splitlines():
                    key, _, text = line.partition(" ")
                    texts[key] = text
            elif member.name.endswith(".flac"):
                key = os.path.basename(member.name)[:-5]
                chapter = key.rsplit("-", 1)[0]
                if sum(k.startswith(chapter) for k in flacs) < 4:
                    flacs[key] = tar.extractfile(member).read()
    rng = random.Random(7)
    chosen = sorted(rng.sample(sorted(k for k in flacs if k in texts), LIBRI_UTTERANCES))
    for key in chosen:
        folder = os.path.join(CLIPS, "libri-clean"); os.makedirs(folder, exist_ok=True)
        flac, wav = os.path.join(folder, key + ".flac"), os.path.join(folder, key + ".wav")
        open(flac, "wb").write(flacs[key]); to_wav(flac, wav); os.remove(flac)
        with wave.open(wav) as w:
            seconds = w.getnframes() / 16000
        items.append({"set": "libri-clean", "id": key, "lang": "en", "wav": wav, "ref": texts[key], "seconds": round(seconds, 2), "speakers": 1})


def prepare_fleurs(items):
    base = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/hi_in"
    tsv = fetch(f"{base}/dev.tsv", os.path.join(RAW, "fleurs-hi-dev.tsv"))
    archive = fetch(f"{base}/audio/dev.tar.gz", os.path.join(RAW, "fleurs-hi-dev.tar.gz"))
    rows = {}
    with open(tsv, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            rows.setdefault(row[1], row[2])  # file name -> raw transcription
    rng = random.Random(7)
    chosen = set(rng.sample(sorted(rows), FLEURS_UTTERANCES))
    folder = os.path.join(CLIPS, "fleurs-hi"); os.makedirs(folder, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name = os.path.basename(member.name)
            if name not in chosen:
                continue
            raw = os.path.join(folder, "raw-" + name)
            open(raw, "wb").write(tar.extractfile(member).read())
            wav = os.path.join(folder, name)
            to_wav(raw, wav); os.remove(raw)
            with wave.open(wav) as w:
                seconds = w.getnframes() / 16000
            items.append({"set": "fleurs-hi", "id": name[:-4], "lang": "hi", "wav": wav, "ref": rows[name], "seconds": round(seconds, 2), "speakers": 1})


def download(url, attempts=8):
    """GET with back-off: the Hugging Face dataset API rate-limits bursts (HTTP 429)."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503) or attempt == attempts - 1:
                raise
            time.sleep(min(60, 2 ** attempt + random.random()))
        except (TimeoutError, ConnectionError, urllib.error.URLError):
            if attempt == attempts - 1:
                raise
            time.sleep(min(60, 2 ** attempt + random.random()))


def prepare_edacc(items):
    """Conversational English across accents: real two-person video calls, which is
    what customers record. Up to EDACC_PER_GROUP utterances per group, of 4-30 seconds
    and at least six words, spread across speakers."""
    index = os.path.join(RAW, "edacc-test-rows.json")
    if not os.path.exists(index):
        rows = []
        for offset in range(0, 10000, 100):
            page = json.loads(download(f"{EDACC_ROWS}&offset={offset}&length=100"))
            rows += [dict(row["row"], index=row["row_idx"]) for row in page["rows"]]
            if offset + 100 >= page["num_rows_total"]:
                break
        json.dump(rows, open(index, "w"))
    rows = json.load(open(index))
    clean = lambda t: re.sub(r"\s+", " ", re.sub(r"<[^>]*>|\[[^\]]*\]|\([^)]*\)", " ", t)).strip()
    rng = random.Random(11)
    for group, accents in EDACC_GROUPS.items():
        pool = [r for r in rows if r["accent"] in accents and len(clean(r["text"]).split()) >= 6]
        rng.shuffle(pool)
        # Round-robin over speakers so one talkative person cannot dominate a group.
        by_speaker = {}
        for r in pool:
            by_speaker.setdefault(r["speaker"], []).append(r)
        chosen, queues = [], list(by_speaker.values())
        while queues and len(chosen) < EDACC_PER_GROUP * 3:
            queues = [q for q in queues if q]
            for q in queues:
                chosen.append(q.pop())
        folder = os.path.join(CLIPS, f"edacc-{group}"); os.makedirs(folder, exist_ok=True)
        kept = 0
        for r in chosen:
            if kept >= EDACC_PER_GROUP:
                break
            wav = os.path.join(folder, f"{r['index']}.wav")
            if not os.path.exists(wav):
                raw = wav + ".src.wav"
                try:
                    audio = download(r["audio"][0]["src"])
                except urllib.error.HTTPError as error:
                    if error.code != 403:
                        raise
                    # Audio links are signed and expire; ask for this row again.
                    fresh = json.loads(download(f"{EDACC_ROWS}&offset={r['index']}&length=1"))["rows"][0]["row"]
                    audio = download(fresh["audio"][0]["src"])
                open(raw, "wb").write(audio)
                to_wav(raw, wav); os.remove(raw)
            with wave.open(wav) as w:
                seconds = w.getnframes() / 16000
            if not 4 <= seconds <= 30:
                os.remove(wav); continue
            kept += 1
            items.append({"set": f"edacc-{group}", "id": str(r["index"]), "lang": "en", "wav": wav, "ref": clean(r["text"]),
                          "accent": r["accent"], "l1": r["l1"], "seconds": round(seconds, 2), "speakers": 1})


HINGLISH = [
    ("Deck मैं Thursday तक भेज दूंगी, बाकी Raghav के साथ sync कर लेंगे", ["deck", "thursday", "raghav", "sync"]),
    ("Invoice Friday से पहले finance को भेजना है", ["invoice", "friday", "finance"]),
    ("Priya, क्या तुम pricing sheet Monday तक update कर सकती हो", ["priya", "pricing", "sheet", "monday", "update"]),
    ("मैं client को call करके contract terms confirm कर लूंगा", ["client", "call", "contract", "terms", "confirm"]),
    ("Sandbox account आज शाम तक ready हो जाएगा", ["sandbox", "account", "ready"]),
    ("Meeting notes मैं कल सुबह share कर दूंगा", ["meeting", "notes", "share"]),
    ("Anika ने बोला कि demo next week होगा", ["anika", "demo", "next", "week"]),
    ("Budget approval के लिए हमें manager से बात करनी पड़ेगी", ["budget", "approval", "manager"]),
    ("Release notes Maya review करेगी, फिर हम ship करेंगे", ["release", "notes", "maya", "review", "ship"]),
    ("Onboarding checklist Tuesday तक final कर दो", ["onboarding", "checklist", "tuesday", "final"]),
    ("Security questionnaire का reply मैं Wednesday को भेजूंगी", ["security", "questionnaire", "reply", "wednesday"]),
    ("Tomas pricing के numbers लेकर आएगा", ["tomas", "pricing", "numbers"]),
]
INDIAN_ENGLISH = [
    ("I will send the revised proposal to Sanjana by Friday evening.", "Aman"),
    ("Can you please share the onboarding checklist with Raghav before Monday?", "Tara"),
    ("Let me check with the finance team and get back to you tomorrow.", "Rishi"),
    ("Priya will own the migration script for this sprint.", "Aman"),
    ("We need to close the security questionnaire before the audit on the twenty third.", "Tara"),
    ("Arjun said the sandbox environment will be ready by Thursday afternoon.", "Rishi"),
    ("I'll handle the invoice myself since Tomas is out next week.", "Aman"),
    ("The client wants a demo of the reporting dashboard in Bengaluru.", "Tara"),
    ("Kavya is going to update the pricing sheet after the call.", "Rishi"),
    ("Please remind me to follow up with Meenakshi about the contract.", "Aman"),
    ("Deepak will review the release notes and then we can ship.", "Tara"),
    ("I'm going to loop in Nikhil on the budget approval.", "Rishi"),
]


def prepare_synthetic(items):
    """Text-to-speech probes for gaps with no public set. Synthetic voices are cleaner
    than people, so these check behaviour (script, English words, names), not accuracy."""
    for kind, rows in (("hinglish-tts", [(t, "Lekha", k) for t, k in HINGLISH]),
                       ("en-in-tts", [(t, v, []) for t, v in INDIAN_ENGLISH])):
        folder = os.path.join(CLIPS, kind); os.makedirs(folder, exist_ok=True)
        for n, (text, voice, keywords) in enumerate(rows):
            aiff, wav = os.path.join(folder, f"{n:02d}.aiff"), os.path.join(folder, f"{n:02d}.wav")
            if not os.path.exists(wav):
                subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
                to_wav(aiff, wav); os.remove(aiff)
            with wave.open(wav) as w:
                seconds = w.getnframes() / 16000
            items.append({"set": kind, "id": f"{n:02d}", "lang": "mixed" if kind == "hinglish-tts" else "en",
                          "wav": wav, "ref": text, "keywords": keywords, "voice": voice,
                          "seconds": round(seconds, 2), "speakers": 1, "synthetic": True})


def main():
    # --only edacc,...: refresh those sets and keep the rest of the manifest as it is.
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
    manifest = os.path.join(DATA, "manifest.json")
    items = []
    if only:
        items = [dict(i, wav=os.path.join(DATA, i["wav"])) for i in json.load(open(manifest, encoding="utf-8"))
                 if not any(i["set"] == o or i["set"].startswith(o + "-") for o in only)]
    steps = {"ami": lambda: prepare_ami(items, fetch(f"{AMI_MIRROR}/annotations/ami_public_manual_1.6.2.zip",
                                                     os.path.join(RAW, "ami_public_manual_1.6.2.zip"))),
             "libri": lambda: prepare_libri(items), "fleurs": lambda: prepare_fleurs(items),
             "synthetic": lambda: prepare_synthetic(items), "edacc": lambda: prepare_edacc(items)}
    for name, step in steps.items():
        if not only or name in only:
            step()
    for item in items:
        item["wav"] = os.path.relpath(item["wav"], DATA)
    json.dump(items, open(os.path.join(DATA, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    summary = {}
    for item in items:
        s = summary.setdefault(item["set"], [0, 0.0])
        s[0] += 1; s[1] += item["seconds"]
    for name, (count, seconds) in summary.items():
        print(f"{name:14s} {count:3d} clips {seconds / 60:5.1f} min")


if __name__ == "__main__":
    main()
