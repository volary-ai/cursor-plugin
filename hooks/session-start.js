#!/usr/bin/env node
//
// Cursor sessionStart hook — fetches the agent's root memory index from
// Volary and injects it into the model's context via additional_context.
//
// Cursor invokes this as:
//   echo '<sessionStart JSON>' | node hooks/session-start.js
//
// The hook outputs JSON to stdout:
//   { "additional_context": "<formatted root index>" }
//
// Configuration (env vars or .cursor/volary.json):
//   VOLARY_API_URL   — Volary API base URL (e.g. https://api.volary.ai)
//   VOLARY_ORG_ID    — Organisation ID
//   VOLARY_AGENT_ID  — Agent ID
//   VOLARY_TOKEN     — API bearer token

import fs from "fs";
import { loadConfig, requireConfig } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Root index formatting — mirrors api/v0/ai_common.go formatRootIndex()
// ---------------------------------------------------------------------------

function formatRootIndex(entries) {
  if (!entries || entries.length === 0) {
    return (
      "The root memory index of reflections from the volary memory system is currently empty. " +
      "There is no need to use the recall tool this session - in future sessions it will be populated."
    );
  }
  const preamble =
    "The following is the root memory index of reflections from the volary memory system. " +
    "These are available via the get_reflection volary MCP tool. " +
    "Use these as starting points when recalling past experience:\n\n";
  const lines = entries.map((e) => `- ${e.label} (${e.type}: ${e.id})`);
  return preamble + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read sessionStart payload from stdin (consumed but not currently used).
  fs.readFileSync(0, "utf-8");

  // 2. Load and validate config.
  const config = requireConfig(loadConfig());

  // 3. Fetch agent to get its root index.
  const url = `${config.apiUrl}/v0/orgs/${config.orgId}/agents/${config.agentId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GET agent failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const agent = await resp.json();
  const content = formatRootIndex(agent.root_index);

  // 4. Output additional_context for Cursor to inject.
  if (content) {
    console.log(JSON.stringify({ additional_context: content }));
  } else {
    console.log("{}");
  }
}

main().catch((err) => {
  console.error(`volary-hook: ${err.message}`);
  process.exit(1);
});
