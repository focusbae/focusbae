"use strict";
// The one link FocusBae answers (owner, 2026-10-22): focusbae://team/connect?workspace=<id>,
// from "Open in FocusBae" on the team website. It only opens Settings > Team workspaces
// with that workspace pointed out; connecting and adding it are still the person's clicks.
// Anything else is ignored, so a link can never act on its own.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTeamLink(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol !== "focusbae:" || url.hostname !== "team" || url.pathname !== "/connect") return null;
  if (url.username || url.password || url.port || url.hash) return null;
  const keys = [...url.searchParams.keys()];
  const workspace = url.searchParams.get("workspace");
  if (keys.length !== 1 || !UUID.test(workspace ?? "")) return null;
  return { workspace: workspace.toLowerCase() };
}

module.exports = { parseTeamLink };
