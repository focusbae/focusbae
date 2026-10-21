#!/usr/bin/env python3
"""Builds a real-meeting gold set from the AMI meeting corpus (CC BY 4.0).

AMI annotators wrote an "actions" list for each meeting and linked every summary sentence
to the dialogue acts it came from. The dialogue acts linked to an action are labelled as
commitments here. Each meeting is cut into windows of about 1,800 characters (what the
app sends to the on-device model at once), and windows holding at least one action are
kept. Speakers are named by their AMI role; the Project Manager is the account owner.

Limits, so results are read correctly:
- Annotators summarised; they did not list every promise. Recall is the useful number;
  "false positives" are often real promises the summary left out.
- A linked act can be discussion around the action rather than the promise itself.
- Owners are not labelled ("ownersLabelled": false): AMI actions say what will be done,
  not who relative to the account owner.

Reads the annotation zip downloaded by qualification/speech/prepare.py and writes
gold/ami/*.json (git-ignored; regenerate with this script). Standard library only.
"""
import json, os, re, sys, zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ZIP = os.path.join(HERE, "../speech/data/raw/ami_public_manual_1.6.2.zip")
OUT = os.path.join(HERE, "gold", "ami")
NITE = "{http://nite.sourceforge.net/}"
ROLES = {"PM": "Project Manager", "ID": "Industrial Designer", "UI": "Interface Designer", "ME": "Marketing Expert"}
WINDOW_CHARS = 1800


def xml(z, name):
    return ET.fromstring(z.read(name))


def ref_ids(href):
    """'file.xml#id(a)..id(b)' -> ('a', 'b'); 'file.xml#id(a)' -> ('a', 'a')."""
    ids = re.findall(r"id\(([^)]+)\)", href)
    return ids[0], ids[-1]


def roles(z):
    out = {}
    for meeting in xml(z, "corpusResources/meetings.xml").iter("meeting"):
        out[meeting.get("observation")] = {s.get("nxt_agent"): ROLES.get(s.get("role"), s.get("role")) for s in meeting.iter("speaker")}
    return out


def acts(z, meeting, agent):
    """Dialogue acts of one speaker: (id, start time, text)."""
    words_file = f"words/{meeting}.{agent}.words.xml"
    acts_file = f"dialogueActs/{meeting}.{agent}.dialog-act.xml"
    if words_file not in z.namelist() or acts_file not in z.namelist():
        return []
    words = [(w.get(f"{NITE}id"), w.get("starttime"), w.text or "", w.get("punc") == "true")
             for w in xml(z, words_file) if w.tag == "w"]
    position = {w[0]: i for i, w in enumerate(words)}
    out = []
    for act in xml(z, acts_file).iter("dact"):
        child = act.find(f"{NITE}child")
        if child is None:
            continue
        first, last = ref_ids(child.get("href"))
        if first not in position or last not in position:
            continue
        span = words[position[first]:position[last] + 1]
        text = ""
        for _, _, token, punc in span:
            text += token if punc or not text else " " + token
        start = next((float(w[1]) for w in span if w[1]), None)
        if text.strip() and start is not None:
            out.append((act.get(f"{NITE}id"), start, text.strip()))
    return out


def actions(z, meeting):
    """Ids of the abstractive sentences under <actions>, skipping "NA"."""
    name = f"abstractive/{meeting}.abssumm.xml"
    if name not in z.namelist():
        return set()
    root = xml(z, name)
    return {s.get(f"{NITE}id") for a in root.iter("actions") for s in a.iter("sentence")
            if (s.text or "").strip().rstrip(".").upper() != "NA"}


def linked(z, meeting, wanted):
    name = f"extractive/{meeting}.summlink.xml"
    if name not in z.namelist():
        return set()
    out = set()
    for link in xml(z, name).iter("summlink"):
        pointers = {p.get("role"): ref_ids(p.get("href"))[0] for p in link.iter(f"{NITE}pointer")}
        if pointers.get("abstractive") in wanted:
            out.add(pointers.get("extractive"))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    with zipfile.ZipFile(ZIP) as z:
        speakers = roles(z)
        meetings = sorted({n.split("/")[1].split(".")[0] for n in z.namelist() if n.startswith("abstractive/") and n.endswith(".abssumm.xml")})
        written = labelled = 0
        for meeting in meetings:
            gold = linked(z, meeting, actions(z, meeting))
            if not gold:
                continue
            names = speakers.get(meeting, {})
            timeline = sorted((start, act_id, names.get(agent, f"Speaker {agent}"), text)
                              for agent in "ABCDE" for act_id, start, text in acts(z, meeting, agent))
            window, size, part = [], 0, 0
            for item in timeline + [None]:
                if item is not None and size + len(item[3]) <= WINDOW_CHARS:
                    window.append(item); size += len(item[3]); continue
                hits = [w for w in window if w[1] in gold]
                if hits:
                    part += 1
                    record = {
                        "id": f"ami-{meeting}-{part:02d}", "source": "ami", "accountOwner": "Project Manager",
                        "ownersLabelled": False,
                        "segments": [{"id": w[1], "speaker": w[2], "text": w[3]} for w in window],
                        "commitments": [{"segmentId": w[1], "quote": w[3], "owner": "unknown"} for w in hits],
                    }
                    json.dump(record, open(os.path.join(OUT, f"{record['id']}.json"), "w"), indent=1)
                    written += 1; labelled += len(hits)
                window, size = ([item], len(item[3])) if item is not None else ([], 0)
    print(f"{written} windows, {labelled} labelled action acts, from AMI action items -> {OUT}")


if __name__ == "__main__":
    main()
