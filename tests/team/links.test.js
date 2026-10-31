"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTeamLink } = require("../../team/links");

const id = "55555555-5555-4555-8555-555555555555";

test("the one link FocusBae answers: focusbae://team/connect with a workspace id", () => {
  assert.deepEqual(parseTeamLink(`focusbae://team/connect?workspace=${id}`), { workspace: id });
  assert.deepEqual(parseTeamLink(`focusbae://team/connect?workspace=${id.toUpperCase()}`), { workspace: id });
});

test("anything else is ignored", () => {
  for (const raw of [
    `focusbae://team/connect`,
    `focusbae://team/connect?workspace=not-a-uuid`,
    `focusbae://team/connect?workspace=${id}&then=delete`,
    `focusbae://team/join?workspace=${id}`,
    `focusbae://auth/callback?token=abc`,
    `focusbae://evil.com/connect?workspace=${id}`,
    `https://team/connect?workspace=${id}`,
    `focusbae://user:pass@team/connect?workspace=${id}`,
    `focusbae://team/connect?workspace=${id}#x`,
    "javascript:alert(1)",
    "",
    null,
  ]) assert.equal(parseTeamLink(raw), null, String(raw));
});

test("release builds use the public team service; development and 'off' do not", () => {
  const { teamUrl } = require("../../team/service");
  assert.equal(teamUrl({}, true), "https://team.focusbae.com");
  assert.equal(teamUrl({}, false), null, "a development run needs FOCUSBAE_TEAM_URL");
  assert.equal(teamUrl({ FOCUSBAE_TEAM_URL: "off" }, true), null);
  assert.equal(teamUrl({ FOCUSBAE_TEAM_URL: "http://localhost:3000/x" }, true), "http://localhost:3000");
  assert.throws(() => teamUrl({ FOCUSBAE_TEAM_URL: "http://team.example.com" }, true), /must be https/);
});
