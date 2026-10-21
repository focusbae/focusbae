# TEAM-02: Cloud transcription in team workspaces (processing level 3)

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
