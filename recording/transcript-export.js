"use strict";

// A whole transcript as one document, for pasting into another tool or saving to a
// file. It reads like the transcript view: the far side's echoes picked up by the
// microphone are left out, and a line without a known speaker names its source.
const SOURCE_NAMES = {
  microphone: "Microphone",
  system: "System audio",
  import: "Imported WAV",
};
const PURPOSE_NAMES = {
  conversation: "Conversation",
  personal: "Voice note",
  learning: "Learning",
};
const clock = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const speakerOf = (segment) =>
  segment.speaker ?? `${SOURCE_NAMES[segment.source] ?? segment.source} · Unknown speaker`;

function formatTranscript({ recording, segments, timeZone }, format = "text") {
  const title = recording.title || PURPOSE_NAMES[recording.purpose] || "Recording";
  const when = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(recording.startedAt));
  const facts = `${when} · ${clock(recording.durationMs ?? 0)}`;
  const lines = segments
    .filter((segment) => !segment.echoOf)
    .map((segment) =>
      format === "markdown"
        ? `**[${clock(segment.startMs)}] ${speakerOf(segment)}:** ${segment.text}`
        : `[${clock(segment.startMs)}] ${speakerOf(segment)}: ${segment.text}`,
    );
  const head = format === "markdown" ? [`# ${title}`, "", facts] : [title, facts];
  return { text: [...head, "", lines.join(format === "markdown" ? "\n\n" : "\n"), ""].join("\n"), lines: lines.length };
}

// A file name from the recording's name and day, without characters macOS Finder
// or other tools treat specially.
function transcriptFileName(recording, extension) {
  const name = (recording.title || PURPOSE_NAMES[recording.purpose] || "Recording")
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${name || "Recording"} ${recording.startedAt.slice(0, 10)}.${extension}`;
}

module.exports = { formatTranscript, transcriptFileName };
