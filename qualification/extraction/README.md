# Extraction Quality Harness

Measures whether an extractor finds real commitments and assigns the right owner.
It is the gate for LF-10: no local model replaces the rule baseline, and no public
claim about local extraction is made, without a result from this harness on real
transcripts.

```bash
npm run qualify:extraction                       # synthetic probes, rule baseline
node qualification/extraction/score.js --gold qualification/extraction/gold/private
node qualification/extraction/score.js --json    # machine-readable
bash local-ai/apple-extract/build.sh && node qualification/extraction/score.js --extractor apple
```

## Metrics

| Metric | Meaning |
| --- | --- |
| precision | Predicted commitments that are real |
| recall | Labelled commitments that were found |
| owner | Of the found commitments, how many have the right owner |
| end-to-end | Labelled commitments found **and** correctly owned — the number the person view depends on |

A prediction matches a label when it cites the same segment and either quote
contains the other. Each label matches at most one prediction; duplicates count as
false positives.

## Gold File Format

```json
{
  "id": "unique-id",
  "source": "synthetic | consented-real",
  "accountOwner": "Me",
  "segments": [{ "id": "s1", "speaker": "Priya", "text": "..." }],
  "commitments": [{ "segmentId": "s1", "quote": "verbatim text", "owner": "self | other | unknown" }]
}
```

- `owner` is relative to the account owner. Use `unknown` when a person could not
  tell from the audio either (for example, two people on one microphone).
- `quote` must appear verbatim in its segment; the loader rejects it otherwise.
- Label what a careful assistant should track: promises and accepted requests.
  Not predictions ("it will rain"), suggestions ("you should try"), or statements
  about third parties outside the conversation ("the speaker will publish").

## Real Transcripts

Real meeting content must not be committed. Put consented transcripts in
`gold/private/` (ignored by git) with `"source": "consented-real"`, and report
only aggregate numbers and redacted examples in evidence documents.

The committed `synthetic-*` files are hand-written probes for known failure
shapes. They prove the scorer works; they are not evidence of real-world quality.

## Adding an Extractor

Add an entry to `EXTRACTORS` in `score.js` that returns
`[{ segmentId, quote, owner }]` for a meeting. Model-backed extractors must run
locally and must not be enabled by default here.
