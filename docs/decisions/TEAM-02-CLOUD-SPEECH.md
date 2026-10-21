# TEAM-02: Cloud processing in team workspaces (levels 2 and 3)

Status: accepted, 2026-10-21.

## Context

Team workspaces have three processing levels, set by an owner or admin as the highest
members may use: 1 on the Mac only (default), 2 cloud AI on transcript text (not built
yet), 3 cloud transcription. On-device speech is good on clean English but loses
accuracy with accents and in meetings, which is what teams record.

## Decision

Level 3 uses **Deepgram Nova-3**, chosen on an English benchmark across accent groups
and meeting audio in `qualification/speech` (no failures, fastest, and better than
on-device speech on every accent group and on meetings).

- **Per recording, by choice.** In a team workspace that allows level 3, the Record
  dialog offers "Deepgram (cloud)" (default) or "This Mac only". Personal workspaces
  never offer it. Every recording shows where it was transcribed.
- **Short-lived tokens, no relay.** For each recording the Mac asks the team service for
  a Deepgram token (about ten minutes, renewed as needed). The service checks membership,
  the workspace's level and an hourly limit, records the grant so owners see use, and
  holds the only long-lived Deepgram key. The Mac sends each utterance to Deepgram itself;
  audio never passes through FocusBae. Every request asks Deepgram not to use it for
  training (`mip_opt_out`).
- **Same engine contract.** `recording/deepgram.js` takes an utterance and returns text,
  like the on-device engines, so resuming after a crash, transcript segments, speaker
  detection and commitment extraction are unchanged.
- **The policy decides at every request.** Requests go out only while the team account
  is connected and Strict Local is off (`privacy/local-policy.js`, purpose `team`). If
  that changes, or the admin lowers the level, before a recording is transcribed, this
  Mac transcribes it instead and the recording says so. A change during transcription
  stops the next request.
- **Languages:** English and Hindi are sent as such; English + Hindi uses Deepgram's
  multilingual mode. Hindi and Hinglish quality is benchmarked next.

## Consequences

- The team service needs `DEEPGRAM_API_KEY` with Deepgram's Member role or higher (the
  role that may issue short-lived tokens).
- Imported WAV files are still transcribed on the Mac.
- Tests: `tests/recording/deepgram.test.js`, the cloud case in
  `tests/recording/recording.test.js`, and the team service rule in
  `tests/team/notes-sync.test.js`; the zero-network test still passes with team
  features on, because nothing is sent unless all of the above hold.

## Level 2: commitments found by OpenAI (added 2026-10-21)

- Levels are cumulative: 3 includes 2. The Record dialog offers what the workspace
  allows: Deepgram + OpenAI, OpenAI on the transcript text only, or This Mac only.
- OpenAI has no short-lived client tokens for this, so the team service relays: the Mac
  sends a part of one transcript (`team/cloud-extraction.js`, at most 40,000 characters
  a request); the service checks membership, the level and an hourly limit, records
  that it happened, calls OpenAI with `store: false`, and returns the answer. No
  transcript text is kept or logged by FocusBae.
- The instructions and answer shape are the on-device model's
  (`local-ai/apple-extract`, `qualification/extraction/cloud.js`), so the same
  extraction code handles both; suggestions are marked "Cloud AI suggestion"
  (origin `cloud-model`).
- If cloud AI is no longer allowed, or fails, the on-device model (or the rules) finds
  the commitments instead and the recording says so.
- Model: `OPENAI_EXTRACT_MODEL` on the service, default `gpt-6.1-sol` (best precision on
  the AMI real-meeting set; see the benchmark).
