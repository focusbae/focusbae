"use strict";
// Cloud extractors for the level 2 benchmark (TEAM_PLAN §3): the same instructions and
// output shape as the on-device model (local-ai/apple-extract), so the comparison is
// about the model, not the prompt. Anthropic is the primary provider and OpenAI the
// backup (owner, 2026-10-21). Keys and model names come from the environment:
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-5-5)
//   OPENAI_API_KEY, OPENAI_MODEL (required; list with: node cloud.js --models openai)
// Only the benchmark's own transcripts are sent. The app does not use this file.

// Keys live in qualification/.env (git-ignored; this repository is public).
try { process.loadEnvFile(require("node:path").join(__dirname, "../.env")); } catch {}

const INSTRUCTIONS = `You find commitments in a conversation transcript. A commitment is a promise to do something or an explicit acceptance of a task, such as "I'll send it Friday", "I'm going to call them", "Let me check and get back to you", or "Raghav will own the script". Include commitments made by every speaker, not only the account owner: the account owner needs to track what others promised too.

Not commitments: predictions ("it will rain"), opinions ("the market will grow"), suggestions ("you should try it"), questions or requests that nobody accepted, and reports of what someone outside the conversation will do ("the speaker said she will publish").

Ownership: the person who will do the work. "I" and "me" refer to the speaker of that segment. Use self only when that person is the account owner. Use other when another identifiable person will do it. Use unknown when the speaker is not labelled and the doer cannot be identified. Copy quotes exactly from the segment.

List every distinct commitment once.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["commitments"],
  properties: {
    commitments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segmentId", "quote", "owner", "person"],
        properties: {
          segmentId: { type: "string", description: "The id of the segment containing the commitment, exactly as given" },
          quote: { type: "string", description: "The exact words of the commitment copied from that segment, without paraphrasing" },
          owner: { type: "string", enum: ["self", "other", "unknown"] },
          person: { type: "string", description: "Name of the person who will do it, or empty when unknown" },
        },
      },
    },
  },
};

// The same prompt the on-device extractor builds.
function prompt(meeting) {
  const transcript = meeting.segments
    .map((s) => `[${s.id}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`)
    .join("\n");
  return `Account owner: ${meeting.accountOwner ?? "Me"}\n\nTranscript:\n${transcript}`;
}

function key(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (put it in qualification/.env, which git ignores)`);
  return value;
}

async function post(url, headers, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    const json = await response.json();
    if (!response.ok) throw new Error(`${response.status} ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
}

const PROVIDERS = {
  anthropic: {
    model: () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    async extract(meeting) {
      const json = await post("https://api.anthropic.com/v1/messages",
        { "x-api-key": key("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
        {
          model: this.model(),
          max_tokens: 4096,
          temperature: 0,
          system: INSTRUCTIONS,
          tools: [{ name: "report_commitments", description: "Report the commitments found", input_schema: SCHEMA }],
          tool_choice: { type: "tool", name: "report_commitments" },
          messages: [{ role: "user", content: prompt(meeting) }],
        });
      const call = json.content.find((part) => part.type === "tool_use");
      if (!call) throw new Error("anthropic: no structured answer");
      return { commitments: call.input.commitments, usage: { input: json.usage.input_tokens, output: json.usage.output_tokens } };
    },
  },
  openai: {
    model: () => key("OPENAI_MODEL"),
    async extract(meeting) {
      const json = await post("https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${key("OPENAI_API_KEY")}` },
        {
          model: this.model(),
          messages: [{ role: "system", content: INSTRUCTIONS }, { role: "user", content: prompt(meeting) }],
          response_format: { type: "json_schema", json_schema: { name: "commitments", strict: true, schema: SCHEMA } },
        });
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("openai: no structured answer");
      return { commitments: JSON.parse(content).commitments, usage: { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } };
    },
  },
};

// Returns the commitments in the shape score.js expects, and adds token use to `totals`.
async function extract(provider, meeting, totals = null) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown provider ${provider}`);
  const { commitments, usage } = await spec.extract(meeting);
  if (totals) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.model = spec.model();
  }
  return commitments.map(({ segmentId, quote, owner, person }) => ({ segmentId, quote, owner, person }));
}

async function listModels(provider) {
  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key("OPENAI_API_KEY")}` } });
    const json = await response.json();
    return json.data.map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort();
  }
  const response = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": key("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" } });
  return (await response.json()).data.map((m) => m.id);
}

if (require.main === module && process.argv.includes("--models")) {
  listModels(process.argv[process.argv.indexOf("--models") + 1] ?? "anthropic")
    .then((ids) => console.log(ids.join("\n")))
    .catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { extract, prompt, INSTRUCTIONS, SCHEMA, listModels };
