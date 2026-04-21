#!/usr/bin/env node
//
// Cursor sessionEnd hook — reads the agent transcript and posts it to
// Volary's messages transcript endpoint.
//
// Cursor's JSONL format wraps content in a "message" envelope:
//   {"role": "user", "message": {"content": [...]}}
// The messages endpoint expects the Anthropic format:
//   {"role": "user", "content": [...]}
// so we just unwrap the envelope before posting.
//
// Cursor invokes this as:
//   echo '<sessionEnd JSON>' | node hook/session-end.js
//
// Configuration (env vars or .cursor/volary.json):
//   VOLARY_API_URL   — Volary API base URL (e.g. https://api.volary.ai)
//   VOLARY_ORG_ID    — Organisation ID
//   VOLARY_AGENT_ID  — Agent ID
//   VOLARY_TOKEN     — API bearer token

import fs from "fs";
import { loadConfig, requireConfig } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read sessionEnd payload from stdin.
  const stdin = fs.readFileSync(0, "utf-8");
  const session = JSON.parse(stdin);

  // 2. Read transcript file.
  const transcriptPath = session.transcript_path;
  if (!transcriptPath) {
    throw new Error("no transcript_path in session payload");
  }

  const transcriptRaw = fs.readFileSync(transcriptPath, "utf-8");
  const entries = transcriptRaw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

  if (entries.length === 0) {
    return;
  }

  // 3. Unwrap Cursor's "message" envelope to get Anthropic-style messages.
  const messages = entries.map((entry) => ({
    role: entry.role,
    content: entry.message?.content ?? [],
  }));

  // 4. Load config and post.
  const config = requireConfig(loadConfig());

  const url = `${config.apiUrl}/v0/orgs/${config.orgId}/agents/${config.agentId}/transcripts/messages`;
  const body = {
    messages,
    conversation_id: session.conversation_id || session.session_id || "",
    duration_ms: session.duration_ms || 0,
    model: session.model || "",
    source: "cursor",
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

main().catch((err) => {
  console.error(`volary-hook: ${err.message}`);
  process.exit(1);
});
