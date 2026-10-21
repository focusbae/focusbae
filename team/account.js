"use strict";
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { createHash, randomBytes } = require("node:crypto");

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_S = 60;

const fail = (code, message) => Object.assign(new Error(message), { code });

// A team account on this Mac. Connecting follows RFC 8252: the browser signs in at the
// team service, which hands a one-time grant to a listener on 127.0.0.1, and the app
// redeems it with its PKCE verifier. Every network call first asks the privacy policy.
class TeamAccount extends EventEmitter {
  constructor({ teamUrl, sessions, policy, openExternal, fetchImpl = fetch }) {
    super();
    this.teamUrl = teamUrl;
    this.sessions = sessions;
    this.policy = policy;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.session = sessions.read();
    this.connecting = null;
    policy.setTeamConnected(!!this.session);
  }

  status() {
    return this.session
      ? { connected: true, email: this.session.user.email, userId: this.session.user.id }
      : { connected: false, connecting: !!this.connecting };
  }

  // Resolves once the browser hands back a grant, or rejects on cancel/timeout.
  connect() {
    if (this.connecting) return this.connecting.promise;
    if (this.policy.strict) return Promise.reject(fail("POLICY_DENIED", "Strict Local is on"));
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") return response.writeHead(404).end();
      if (url.searchParams.get("state") !== state) return response.writeHead(400).end("This link does not belong to this request.");
      try {
        await this.#redeem(url.searchParams.get("code"), verifier);
        page(response, "FocusBae is connected", "You can close this tab and return to FocusBae.");
        finish(null);
      } catch (error) {
        page(response, "Could not connect", "Return to FocusBae and try again.");
        finish(error);
      }
    });
    const timer = setTimeout(() => finish(fail("CONNECT_TIMEOUT", "Connecting timed out")), CONNECT_TIMEOUT_MS);
    const finish = (error) => {
      clearTimeout(timer);
      server.close();
      this.connecting = null;
      this.emit("change", this.status());
      if (error) settle.reject(error); else settle.resolve(this.status());
    };
    this.connecting = { promise, cancel: () => finish(fail("CANCELLED", "Connecting was cancelled")) };
    server.listen(0, "127.0.0.1", () => {
      const target = new URL("/connect/desktop", this.teamUrl);
      target.search = new URLSearchParams({ port: String(server.address().port), state, challenge }).toString();
      Promise.resolve(this.openExternal(target.toString())).catch((error) => finish(error));
    });
    this.emit("change", this.status());
    return promise;
  }

  cancelConnect() {
    this.connecting?.cancel();
  }

  disconnect() {
    this.sessions.clear();
    this.session = null;
    this.policy.setTeamConnected(false);
    this.emit("change", this.status());
  }

  async #redeem(code, verifier) {
    if (!code || code.length > 128) throw fail("INVALID_GRANT", "Missing grant");
    const response = await this.fetch(new URL("/api/desktop/token", this.teamUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
    if (!response.ok) throw fail("INVALID_GRANT", "The team service refused this connection");
    const body = await response.json();
    this.#store(body);
    this.policy.setTeamConnected(true);
  }

  #store(body) {
    for (const key of ["accessToken", "refreshToken", "supabaseUrl", "supabaseAnonKey"])
      if (typeof body[key] !== "string") throw fail("INVALID_GRANT", "Incomplete session");
    this.session = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Number(body.expiresAt) || 0,
      supabaseUrl: body.supabaseUrl,
      supabaseAnonKey: body.supabaseAnonKey,
      user: { id: body.user?.id, email: body.user?.email ?? this.session?.user?.email ?? "" },
    };
    this.sessions.write(this.session);
  }

  async #accessToken(ticket) {
    if (!this.session) throw fail("SIGNED_OUT", "No team account is connected");
    if (this.session.expiresAt - REFRESH_MARGIN_S > Date.now() / 1000) return this.session.accessToken;
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL("/auth/v1/token?grant_type=refresh_token", this.session.supabaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.session.supabaseAnonKey },
      body: JSON.stringify({ refresh_token: this.session.refreshToken }),
    });
    if (response.status === 400 || response.status === 401) {
      this.disconnect();
      throw fail("SIGNED_OUT", "The team session ended. Connect again.");
    }
    if (!response.ok) throw fail("NETWORK", `Refresh failed (${response.status})`);
    const body = await response.json();
    this.#store({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      supabaseUrl: this.session.supabaseUrl,
      supabaseAnonKey: this.session.supabaseAnonKey,
      user: { id: body.user?.id ?? this.session.user.id, email: body.user?.email },
    });
    return this.session.accessToken;
  }

  // Calls a database function as the signed-in person. Throws POLICY_DENIED when the
  // policy changed (Strict Local, disconnect) while the request was being prepared.
  async rpc(name, args) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL(`/rest/v1/rpc/${name}`, this.session.supabaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: this.session.supabaseAnonKey,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = body?.message ?? `Request failed (${response.status})`;
      const code = /not allowed/.test(message) ? "FORBIDDEN" : /changed elsewhere/.test(message) ? "VERSION_CONFLICT" : "REMOTE";
      throw fail(code, message);
    }
    return body;
  }

  // Stores a file in the team's private storage, replacing any earlier version.
  async upload(bucket, objectPath, bytes, contentType) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL(`/storage/v1/object/${bucket}/${objectPath}`, this.session.supabaseUrl), {
      method: "POST",
      headers: {
        apikey: this.session.supabaseAnonKey,
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (response.status === 403) throw fail("FORBIDDEN", "Upload not allowed");
    if (!response.ok) throw fail("REMOTE", `Upload failed (${response.status})`);
  }

  // A short-lived Deepgram token for one recording's cloud transcription (level 3). The
  // team service checks the workspace allows it and records the grant; audio then goes
  // from this Mac to Deepgram, never through the team service.
  async speechToken(workspace) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL("/api/desktop/speech-token", this.teamUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 403) throw fail("FORBIDDEN", "Cloud transcription isn't allowed for this workspace");
    if (response.status === 429) throw fail("RATE_LIMITED", "Too many cloud transcriptions in the last hour");
    if (!response.ok || !body.accessToken) throw fail("REMOTE", `Cloud transcription is unavailable (${body.error ?? response.status})`);
    return { accessToken: body.accessToken, expiresAt: body.expiresAt };
  }

  // Commitments in part of one transcript, found by OpenAI through the team service
  // (level 2). The service relays without storing; this returns the model's answer.
  async extract(workspace, { owner, segments }) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL("/api/desktop/extract", this.teamUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace, owner, segments }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 403) throw fail("FORBIDDEN", "Cloud AI isn't allowed for this workspace");
    if (response.status === 429) throw fail("RATE_LIMITED", "Too many cloud AI requests in the last hour");
    if (!response.ok || !Array.isArray(body.commitments)) throw fail("REMOTE", `Cloud AI is unavailable (${body.error ?? response.status})`);
    return body.commitments;
  }

  // Reads a file from the team's private storage; null when it is not there (yet).
  async download(bucket, objectPath) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL(`/storage/v1/object/authenticated/${bucket}/${objectPath}`, this.session.supabaseUrl), {
      headers: { apikey: this.session.supabaseAnonKey, authorization: `Bearer ${token}` },
    });
    if ([400, 404].includes(response.status)) return null;
    if (response.status === 403) throw fail("FORBIDDEN", "Download not allowed");
    if (!response.ok) throw fail("REMOTE", `Download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async select(path) {
    const ticket = this.policy.ticket();
    this.policy.assert("team", ticket);
    const token = await this.#accessToken(ticket);
    this.policy.assert("team", ticket);
    const response = await this.fetch(new URL(`/rest/v1/${path}`, this.session.supabaseUrl), {
      headers: { apikey: this.session.supabaseAnonKey, authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw fail("REMOTE", `Request failed (${response.status})`);
    return response.json();
  }
}

function page(response, title, body) {
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#f8f7f2;color:#293a31;display:grid;place-items:center;min-height:90vh">
<div style="text-align:center"><h1 style="font-family:Georgia,serif;font-weight:400">${escape(title)}</h1><p>${escape(body)}</p></div>`);
}

module.exports = { TeamAccount };
