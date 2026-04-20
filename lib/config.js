// Shared configuration loader for Volary Cursor hooks.
//
// Configuration (env vars or .cursor/volary.json):
//   VOLARY_API_URL   — Volary API base URL (e.g. https://api.volary.ai)
//   VOLARY_ORG_ID    — Organisation ID
//   VOLARY_AGENT_ID  — Agent ID
//   VOLARY_TOKEN     — API bearer token

import fs from "fs";
import path from "path";
import os from "os";

export function loadConfig() {
  // Precedence: env vars > project file > user file > built-in default.
  const env = {
    apiUrl: process.env.VOLARY_API_URL,
    orgId: process.env.VOLARY_ORG_ID,
    agentId: process.env.VOLARY_AGENT_ID,
    token: process.env.VOLARY_TOKEN,
  };

  // Read user-level first, then project-level so project overrides user.
  // Cursor sets CURSOR_PROJECT_DIR; fall back to cwd for manual invocation.
  const projectDir = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const files = [
    path.join(os.homedir(), ".cursor", "volary.json"),
    path.join(projectDir, ".cursor", "volary.json"),
  ];
  const merged = {};
  for (const candidate of files) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const file = JSON.parse(raw);
      if (file.api_url) merged.apiUrl = file.api_url;
      if (file.org_id) merged.orgId = file.org_id;
      if (file.agent_id) merged.agentId = file.agent_id;
      if (file.token) merged.token = file.token;
    } catch {
      // File doesn't exist or isn't valid JSON — skip.
    }
  }

  return {
    apiUrl: env.apiUrl || merged.apiUrl || "https://api.volary.ai",
    orgId: env.orgId || merged.orgId,
    agentId: env.agentId || merged.agentId,
    token: env.token || merged.token,
  };
}

export function requireConfig(config) {
  const missing = ["apiUrl", "orgId", "agentId", "token"].filter(
    (k) => !config[k],
  );
  if (missing.length > 0) {
    throw new Error(`missing config: ${missing.join(", ")}`);
  }
  return config;
}
