/**
 * Utterance segmentation for locally captured meeting audio.
 *
 * Speech recognizers want utterance-sized audio. Handing it a raw stream produces bad
 * timestamps and worse latency; handing it fixed 30-second windows cuts sentences
 * in half, and a commitment split across a boundary ("I'll send you the deck" /
 * "by Thursday") loses its deadline. So audio is cut where the speaker actually
 * pauses.
 *
 * Energy-based voice activity detection with an adaptive noise floor. Adaptive is
 * the whole point: a fixed threshold that works in a quiet room fails on a laptop
 * fan, in a cafe, or on a cheap headset, and those are the conditions this has to
 * survive. The floor falls fast and rises slowly, so it settles onto true silence
 * quickly but is not dragged upward by someone talking for a minute straight.
 *
 * Deliberately not a neural VAD. Silero would be more accurate at the margins, but
 * it is another model to bundle and load, and the failure it prevents -- clipping
 * the first phoneme of a sentence -- is one recognition recovers from. Energy VAD is
 * ~20 lines and runs in microseconds.
 *
 * Audio contract: 16 kHz, mono, signed 16-bit little-endian. That is what audiotee
 * emits when given a sample rate, and what the speech helper consumes, so nothing in this
 * path resamples.
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE;

// How much silence ends an utterance. Natural sentence-internal pauses run
// 200-500ms, so anything below ~600 chops mid-thought. Above ~1s and two separate
// remarks get glued into one segment with a misleading start time.
const SILENCE_HANG_MS = 700;

// Below this an "utterance" is a keyboard click, a door, or a breath. Transcribing
// it wastes a recognition call and can yield invented text -- Whisper, the original engine, was notorious for
// inventing "Thank you." out of near-silence.
const MIN_UTTERANCE_MS = 400;

// Someone monologuing must still be flushed periodically: recognition accuracy degrades
// on very long inputs, and the user should not wait until a speaker draws breath to
// see anything. Cut at a pause if one exists, otherwise force it here.
const MAX_UTTERANCE_MS = 25000;

// Speech must exceed the noise floor by this factor. 3x is roughly 10dB, which
// separates speech from room tone without losing a soft talker.
const SPEECH_MULTIPLIER = 3.0;

// Absolute floor, so a perfectly silent digital stream (no mic connected, or a
// muted tab) cannot drive the adaptive threshold to zero and make every frame
// register as speech.
const ABSOLUTE_FLOOR = 180; // int16 RMS units

// Asymmetric adaptation rates. Falls fast onto genuine quiet, rises slowly so
// sustained speech does not lift the floor above itself and mute the detector.
const FLOOR_FALL = 0.25;
const FLOOR_RISE = 0.002;

function rms(buf, offset, lengthBytes) {
  let sum = 0;
  const end = offset + lengthBytes;
  for (let i = offset; i + 1 < end; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  const n = lengthBytes / BYTES_PER_SAMPLE;
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * Streaming segmenter for one audio source.
 *
 * One instance per stream. The microphone and the system output are segmented
 * independently on purpose -- they overlap constantly in real conversation, and a
 * shared segmenter would merge an interruption into whatever the other party was
 * saying.
 */
class Segmenter {
  /**
   * @param {object} opts
   * @param {string} opts.speaker  label attached to emitted utterances
   * @param {function} opts.onUtterance  ({ speaker, pcm, startMs, endMs }) => void
   */
  constructor({ speaker, onUtterance, ...tuning } = {}) {
    this.speaker = speaker || "unknown";
    this.onUtterance = onUtterance || (() => {});

    this.silenceHangMs = tuning.silenceHangMs ?? SILENCE_HANG_MS;
    this.minUtteranceMs = tuning.minUtteranceMs ?? MIN_UTTERANCE_MS;
    this.maxUtteranceMs = tuning.maxUtteranceMs ?? MAX_UTTERANCE_MS;

    // Bytes not yet forming a whole frame.
    this._pending = Buffer.alloc(0);
    // Frames belonging to the utterance being built.
    this._voiced = [];
    // Leading silence is dropped, but silence *inside* an utterance is kept:
    // removing it would splice words together and change how the recognizer hears them.
    this._trailingSilence = [];

    this._noiseFloor = null;
    this._streamMs = 0;      // total audio seen, the clock for timestamps
    this._utteranceStartMs = null;
    this._silenceMs = 0;
  }

  /** Feed a chunk of int16 mono PCM. */
  push(chunk) {
    if (!chunk || !chunk.length) return;

    const buf = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk;
    let offset = 0;

    while (offset + FRAME_BYTES <= buf.length) {
      this._frame(buf.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }

    this._pending = buf.subarray(offset);
  }

  _frame(frame) {
    const level = rms(frame, 0, frame.length);

    if (this._noiseFloor === null) {
      // Seed at or below ABSOLUTE_FLOOR, never at the first frame's level.
      //
      // Seeding from the first frame is the obvious thing and it is wrong: capture
      // usually starts with someone already mid-sentence, which calibrates the
      // floor to speech level. Because the floor only rises slowly and falls when
      // level < floor, it then sits there and the detector is deaf for the whole
      // first turn -- exactly the turn most likely to contain "so what I need from
      // you is...". Seeding low fails the safe way: a little extra audio at the
      // start, which recognition discards as silence.
      this._noiseFloor = Math.min(level, ABSOLUTE_FLOOR);
    }

    const threshold = Math.max(this._noiseFloor * SPEECH_MULTIPLIER, ABSOLUTE_FLOOR);
    const isSpeech = level > threshold;

    // Adapt the floor on silence only.
    //
    // Letting speech contribute is the subtle killer: at any rise rate slow enough
    // to be useful, a sustained monologue still drags the floor up until the
    // threshold exceeds the speaker's own level and the detector goes deaf
    // mid-sentence. Measured at the original rates it took about 3.6 seconds --
    // well inside a normal turn. Estimating background noise only from frames
    // already judged to be background is both the standard construction and the
    // only one that is stable under long speech.
    if (!isSpeech) {
      const rate = level < this._noiseFloor ? FLOOR_FALL : FLOOR_RISE;
      this._noiseFloor += (level - this._noiseFloor) * rate;
    }

    this._streamMs += FRAME_MS;

    if (isSpeech) {
      if (this._utteranceStartMs === null) {
        this._utteranceStartMs = this._streamMs - FRAME_MS;
      }
      // Silence that turned out to be mid-utterance is part of the utterance.
      if (this._trailingSilence.length) {
        this._voiced.push(...this._trailingSilence);
        this._trailingSilence = [];
      }
      this._voiced.push(frame);
      this._silenceMs = 0;

      const spokenMs = this._voiced.length * FRAME_MS;
      if (spokenMs >= this.maxUtteranceMs) {
        this._flush();
      }
      return;
    }

    if (this._utteranceStartMs === null) {
      // Silence before anyone has spoken. Nothing to buffer.
      return;
    }

    this._trailingSilence.push(frame);
    this._silenceMs += FRAME_MS;
    if (this._silenceMs >= this.silenceHangMs) {
      this._flush();
    }
  }

  _flush() {
    const frames = this._voiced;
    const startMs = this._utteranceStartMs;

    this._voiced = [];
    this._trailingSilence = [];
    this._utteranceStartMs = null;
    this._silenceMs = 0;

    if (!frames.length || startMs === null) return;

    const durationMs = frames.length * FRAME_MS;
    if (durationMs < this.minUtteranceMs) {
      // Too short to be speech. Dropping it is not just an optimisation --
      // recognizers (Whisper especially) invent filler text out of sub-second noise.
      return;
    }

    this.onUtterance({
      speaker: this.speaker,
      pcm: Buffer.concat(frames),
      startMs,
      endMs: startMs + durationMs,
    });
  }

  /** Emit whatever is buffered. Called when the meeting ends. */
  end() {
    this._pending = Buffer.alloc(0);
    this._flush();
  }

  /** Introspection for tests and for the debug panel. */
  get noiseFloor() {
    return this._noiseFloor;
  }
}

module.exports = {
  Segmenter,
  SAMPLE_RATE,
  FRAME_MS,
  FRAME_BYTES,
  SILENCE_HANG_MS,
  MIN_UTTERANCE_MS,
  MAX_UTTERANCE_MS,
  ABSOLUTE_FLOOR,
  _rms: rms,
};
