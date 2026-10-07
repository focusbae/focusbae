"use strict";
const { EventEmitter } = require("node:events");
class LocalPolicy extends EventEmitter {
  constructor({ strict = false } = {}) { super(); this.strict = strict; this.epoch = 0; this.grants = new Set(); }
  snapshot() { return { consentVersion: 1, mode: this.strict ? "strict-local" : "local",
    connected: false, grants: [...this.grants], monitoring: [], epoch: this.epoch }; }
  allows(purpose) { return !this.strict && ["models", "updates"].includes(purpose) && this.grants.has(purpose); }
  ticket() { return String(this.epoch); }
  assert(purpose, ticket = this.ticket()) {
    if (!this.allows(purpose) || ticket !== this.ticket()) throw Object.assign(new Error("Permission denied"), { code: "POLICY_DENIED" });
  }
  authorize(purpose) {
    if (this.strict || !["models", "updates"].includes(purpose)) this.assert(purpose);
    this.grants.add(purpose); this.emit("change", this.snapshot());
  }
  revoke(purpose) { this.grants.delete(purpose); this.epoch++; this.emit("change", this.snapshot()); }
  setStrict(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid privacy mode");
    this.strict = enabled; this.grants.clear(); this.epoch++; this.emit("change", this.snapshot());
  }
}
module.exports = { LocalPolicy };
