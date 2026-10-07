# Speech Engine Benchmark

Compares local transcription engines on the same audio: word error rate (WER),
character error rate (CER, most meaningful for Hindi), speed and peak memory.

```bash
python3 qualification/speech/prepare.py          # ~900 MB download into data/ (git-ignored)
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  qualification/speech/bench.cjs --engines apple,apple-en-in,parakeet \
  --fluidaudio /path/to/fluidaudiocli
... bench.cjs --report                             # re-print the table from cached results
```

Whisper was measured in the original run (see
`docs/benchmarks/speech.md`) and has since been removed
from the app, so it is no longer an engine here. Apple uses `meeting-capture/bin/focusbae-transcribe`
(`npm run build:speech`) with `en-US` or `hi-IN`. Parakeet uses the FluidAudio CLI
(`swift build -c release --product fluidaudiocli` in a FluidAudio checkout); it is
English-only here because Parakeet TDT v3 has no Hindi.

## Sets

| Set | Audio | Why |
| --- | --- | --- |
| `ami-headset` | AMI meetings, close-talk headset mix, 4 meetings × up to 12 clips | Closest to a video call |
| `ami-farfield` | AMI meetings, table-top array microphone 1, 2 meetings | A laptop microphone in a room |
| `libri-clean` | LibriSpeech test-clean, 40 utterances | Clean read-speech baseline |
| `fleurs-hi` | FLEURS Hindi dev, 40 utterances | Hindi support |

AMI clips are 12–30 s, cut at pauses of at least 0.4 s so no reference word is split.
Fillers (uh, um, mm-hmm, …) are removed from both reference and hypothesis; English
numbers are spelled out before scoring.

## Limits

- No Hinglish (code-mixed) set. The app's `mixed` language setting is not measured here.
- Read speech (LibriSpeech, FLEURS) is easier than conversation.
- Per-clip timing for Parakeet and Apple includes process start and model load, as a
  one-shot CLI call does.
- The first Apple Hindi clip may include macOS downloading the `hi-IN` asset.
- A handful of clips per meeting is a sample, not the official AMI evaluation.

## Data licences and attribution

- **AMI Meeting Corpus** — CC BY 4.0, AMI Consortium / University of Edinburgh.
  Audio for the headset mix via the FluidInference mirror
  (`huggingface.co/datasets/FluidInference/ami-corpus-mirror`); array audio from
  `groups.inf.ed.ac.uk/ami`.
- **LibriSpeech** — CC BY 4.0, V. Panayotov, G. Chen, D. Povey, S. Khudanpur
  (`openslr.org/12`).
- **FLEURS** — CC BY 4.0, Google (`huggingface.co/datasets/google/fleurs`).

Downloaded data and results stay local and are never committed.
