"use strict";
const { EventEmitter } = require("node:events");
// Network purposes. "models" and "updates" are granted per session on request; "team"
// is on only while a team account is connected (an explicit choice the person made in
// Settings). Strict Local blocks all three, and every change bumps the epoch so work
// started under the old rules is cancelled.
class LocalPolicy extends EventEmitter {
  constructor({ strict = false } = {}) {
    super(); this.strict = strict; this.epoch = 0; this.grants = new Set(); this.teamConnected = false;
  }
  snapshot() { return { consentVersion: 1, mode: this.strict ? "strict-local" : "local",
    connected: this.teamConnected, grants: [...this.grants], monitoring: [], epoch: this.epoch }; }
  allows(purpose) {
    if (this.strict) return false;
    if (purpose === "team") return this.teamConnected;
    return ["models", "updates"].includes(purpose) && this.grants.has(purpose);
  }
  ticket() { return String(this.epoch); }
  assert(purpose, ticket = this.ticket()) {
    if (!this.allows(purpose) || ticket !== this.ticket()) throw Object.assign(new Error("Permission denied"), { code: "POLICY_DENIED" });
  }
  authorize(purpose) {
    if (this.strict || !["models", "updates"].includes(purpose)) this.assert(purpose);
    this.grants.add(purpose); this.emit("change", this.snapshot());
  }
  revoke(purpose) { this.grants.delete(purpose); this.epoch++; this.emit("change", this.snapshot()); }
  setTeamConnected(connected) {
    if (typeof connected !== "boolean") throw new TypeError("Invalid team state");
    if (connected === this.teamConnected) return;
    this.teamConnected = connected; this.epoch++; this.emit("change", this.snapshot());
  }
  setStrict(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid privacy mode");
    this.strict = enabled; this.grants.clear(); this.epoch++; this.emit("change", this.snapshot());
  }
}
module.exports = { LocalPolicy };
