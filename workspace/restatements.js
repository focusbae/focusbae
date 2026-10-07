"use strict";
// Restatements: the same commitment promised again in a later conversation.
//
// Matching is deliberately conservative, because wrongly merging two different
// promises is worse than missing a restatement. A candidate must have the same
// owner, still be open, and share most of its content words. Time words are
// ignored on purpose: a moved deadline ("send the deck Friday" -> "send the deck
// Monday") is the most common restatement there is, and is exactly what should be
// counted rather than treated as a different promise.
//
// Heavily reworded restatements ("get the deck over to you") are missed. That is
// the intended trade: a wrong link is visible and damages trust, a miss is not.
const v = require("./validation");

const OPEN = new Set(["proposed", "accepted", "deferred"]);
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "get", "going", "had", "has", "have", "he", "her",
  "him", "his", "i", "if", "ill", "im", "in", "into", "is", "it", "its", "ive", "let",
  "lets", "me", "my", "need", "needs", "of", "on", "once", "or", "our", "out", "over",
  "shall", "she", "should", "so", "sure", "than", "that", "the", "their", "them", "then",
  "they", "this", "to", "too", "us", "was", "we", "well", "were", "will", "with", "would",
  "you", "your", "yours",
]);
// Ignored so a changed date still counts as the same promise.
const TIME_WORDS = new Set([
  "today", "tomorrow", "tonight", "yesterday", "morning", "afternoon", "evening",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "week", "weeks", "weekend", "month", "months", "quarter", "day", "days", "eod", "asap",
  "next", "last", "later", "soon", "now", "before", "after", "by", "until", "till",
]);

// Content words a commitment is about: no stopwords, no dates, no bare numbers.
function significantWords(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word) && !TIME_WORDS.has(word) && !/^\d+$/.test(word));
  return new Set(words);
}

// Jaccard overlap of content words, with the number they share.
function similarity(a, b) {
  const left = a instanceof Set ? a : significantWords(a);
  const right = b instanceof Set ? b : significantWords(b);
  if (!left.size || !right.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return { score: shared / (left.size + right.size - shared), shared };
}

const MIN_SCORE = 0.6;
const MIN_SHARED = 2;

function sameOwner(a, b) {
  if (a.owner.kind !== b.owner.kind) return false;
  if (a.owner.kind === "person")
    return (a.owner.id ?? null) === (b.owner.id ?? null) ||
      (a.ownerLabel ?? "").toLowerCase() === (b.ownerLabel ?? "").toLowerCase();
  return true;
}

// The earliest surviving action in a restatement chain, so every restatement of the
// same promise points at one root and the count is stable however they arrive. A
// deleted ancestor is walked through but never returned: new restatements attach to
// the earliest promise that still exists.
function rootOf(store, workspaceId, action) {
  const seen = new Set();
  let current = action;
  let earliest = action.deletedAt ? null : action;
  while (current.restatementOf && !seen.has(current.id)) {
    seen.add(current.id);
    try {
      current = store.get({ workspaceId }, "action", current.restatementOf, { includeDeleted: true });
    } catch {
      break;
    }
    if (!current.deletedAt) earliest = current;
  }
  return earliest ?? current;
}

/**
 * The open commitment a new one restates, or null.
 * @param {object} candidate { title, owner, ownerLabel, recordingId }
 */
function findRestated(store, workspaceId, candidate, { actions, segmentRecording } = {}) {
  const words = significantWords(candidate.title);
  if (words.size < MIN_SHARED) return null;
  const rows = actions ?? store.list({ workspaceId }, "action", { limit: 1000 });
  let best = null;
  for (const action of rows) {
    if (action.id === candidate.id || !OPEN.has(action.status) || !sameOwner(candidate, action)) continue;
    // A promise repeated inside the same conversation is not a restatement; the
    // extractor's own overlap check already keeps one suggestion per commitment.
    const otherRecording = segmentRecording?.get(action.evidence?.[0]?.segmentId) ?? null;
    if (candidate.recordingId && otherRecording && candidate.recordingId === otherRecording) continue;
    const { score, shared } = similarity(words, action.title);
    if (shared < MIN_SHARED || score < MIN_SCORE) continue;
    if (!best || score > best.score) best = { action, score };
  }
  if (!best) return null;
  const root = rootOf(store, workspaceId, best.action);
  return root.deletedAt ? null : root.id;

}

/**
 * How many times this promise has been made, oldest first, ignoring any the user
 * deleted. One entry means it has been promised once, so nothing is shown for it.
 */
function chain(store, workspaceId, id) {
  v.uuid(id);
  const action = store.get({ workspaceId }, "action", id);
  const root = rootOf(store, workspaceId, action);
  const all = store.list({ workspaceId }, "action", { limit: 1000 });
  const members = new Map([[root.id, root]]);
  let added = true;
  while (added) {
    added = false;
    for (const candidate of all)
      if (!members.has(candidate.id) && candidate.restatementOf && members.has(candidate.restatementOf)) {
        members.set(candidate.id, candidate);
        added = true;
      }
  }
  // A promise the user deleted is still the link others point at, but it is not
  // something they were promised: deleting it must lower the count, not keep it.
  const items = [...members.values()]
    .filter((member) => !member.deletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((member) => ({
      id: member.id,
      title: member.title,
      status: member.status,
      dueDate: member.dueDate,
      createdAt: member.createdAt,
      current: member.id === id,
    }));
  return { count: items.length, first: items[0]?.createdAt ?? null, items };
}

module.exports = { significantWords, similarity, findRestated, chain, rootOf, MIN_SCORE, MIN_SHARED };
