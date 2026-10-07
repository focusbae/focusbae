# LF-09b Evidence: Speech Engine Benchmark

Date: 2026-09-17. Owner: Claude Code. Machine: Apple M1, 8 GB, macOS 27.0.
Harness: `qualification/speech/` (`prepare.py`, `bench.cjs`, README with data licences).
Raw results stay local in `qualification/speech/results/` (git-ignored).

Lower is better for error rates. "x realtime" is audio seconds per processing second.

## English (word error rate %)

| Set | Clips | Apple (en-US) | Parakeet TDT v3 | Whisper Turbo | Whisper Small |
| --- | --- | --- | --- | --- | --- |
| LibriSpeech clean read speech | 40 | **2.1** | 2.7 | 3.2 | 5.1 |
| AMI meetings, headset mix | 36 | 25.2 | **21.9** | 25.4 | 26.9 |
| AMI meetings, table microphone | 18 | 31.0 | **24.5** | 29.1 | 33.4 |
| Indian English (synthetic TTS) | 12 | 4.5 | 5.2 | **3.0** | 6.0 |

`apple-en-in` (en-IN locale) scored the same 4.5 on Indian English as en-US.

## Hindi and Hinglish

| Set | Metric | Apple (hi-IN) | Whisper Turbo | Whisper Small | Parakeet |
| --- | --- | --- | --- | --- | --- |
| FLEURS Hindi, 40 clips | WER / CER, Devanagari | n/a (Latin output) | 36.0 / 16.3 | 55.8 / 28.3 | unsupported |
| FLEURS Hindi | Loose romanized CER | 14.8 (2 empty outputs) | **9.2** | 17.1 | unsupported |
| Hinglish (synthetic TTS), 12 clips | Loose romanized CER | **10.3** | 36.4 | 54.5 | unsupported |
| Hinglish | English keywords kept | 74% | 78% | 83% | unsupported |

Apple always returns Hindi in Latin script (also with `hi-Deva-IN` and `mul-IN`).
The loose romanized CER maps every output to a rough shared phonetic spelling; it is
approximate (unrelated English text scores ~77%).

**Whisper translated Hinglish instead of transcribing it**, with the app's own
`mixed -> en` setting, for example:

- Reference: "Priya, क्या तुम pricing sheet Monday तक update कर सकती हो"
- Whisper Small: "Prya, can you update pricing sheet Monday?"
- Whisper Turbo: "Priya, can you get the pricing sheet on Monday to update?"
- Apple hi-IN: "priya kya tum pricing sheet mandir tak kar sakti Ho?"

Whisper's high keyword score comes from English paraphrase, not verbatim transcript,
which breaks quotable evidence. `meeting-capture/transcriber.js` records the opposite
behaviour for Turbo on a real human recording; this probe is synthetic speech, so the
two observations need a real Hinglish recording to settle.

## Speed, memory and download (AMI headset unless noted)

| Engine | x realtime | Median clip | Peak memory | Download |
| --- | --- | --- | --- | --- |
| Apple | 46 | 443 ms | 19 MB helper process* | None shipped (OS language assets) |
| Parakeet | 34 | 504 ms | 105 MB | 461 MB |
| Whisper Small | 14 | 1,552 ms | 661-819 MB | 488 MB |
| Whisper Turbo | 5.7 (1.6 on Hindi) | 3,307 ms | 710-775 MB | 574 MB |

\* Apple's recognizer runs in a system service; the figure covers only our helper,
not the system process, so it is not comparable to the others.

Per-clip times include process start and model load for Apple and Parakeet; Whisper
times the addon call, which also loads the model each time.

## Reading

- English conversation: Parakeet is most accurate on both meeting sets (about 3-7
  points better than the others); Apple and Whisper Turbo are close to each other.
- Clean English: all but Whisper Small are within about one point.
- Hindi: only Whisper Turbo produces Devanagari at usable quality; Apple is
  comparable in content but romanized. Whisper Small is clearly worse.
- Hinglish: Apple hi-IN was the only engine that kept the speaker's words.
- Cost: Apple needs no download and is fastest; Whisper Turbo is 8x slower than
  Apple and needs 574 MB.

## Limits

- 36 + 18 AMI clips from 4 meetings is a sample, not the official AMI evaluation.
- Synthetic TTS sets test behaviour (script, English words, names), not accuracy.
- No real Hinglish or Indian-accented meeting audio was available.
- Apple Hindi's first clip included macOS installing the `hi-IN` asset. The adapter
  requests that download itself, which conflicts with Strict Local and must be
  gated before the Apple path is wired into the local-first pipeline.
- `meeting-capture/apple-speech/Sources/main.swift` gained an optional locale
  argument for this benchmark; the existing caller is unchanged.

## Decision (D-06)

Apple SpeechAnalyzer is the default engine on macOS 26+ for English (en-US) and for
Hindi and mixed speech (hi-IN, Latin-script output). Parakeet TDT v3 is an optional,
user-initiated download that improves English meeting accuracy. Whisper is not used.
Apple language assets are installed only by explicit user action.
