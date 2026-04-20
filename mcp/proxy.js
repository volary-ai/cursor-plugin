#!/usr/bin/env node
//
// Local stdio MCP proxy for the Volary remote MCP server.
//
// Cursor launches this as an MCP server over stdio; we forward every
// JSON-RPC message to the agent's Streamable HTTP MCP endpoint. Auth and
// routing come from the same loadConfig() the hooks use, so users configure
// the plugin in one place (~/.cursor/volary.json, project file, or env vars).

import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConfig } from "../lib/config.js";

// runProxy wires stdin/stdout to a remote Streamable HTTP MCP server.
// Exported for tests — the default main() below calls it with real streams.
export async function runProxy({
  url,
  token,
  stdin,
  stdout,
  stderr,
  fetch = globalThis.fetch,
}) {
  let protocolVersion = null;
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  const writeLine = (s) => {
    stdout.write(s.replace(/[\r\n]+/g, " ") + "\n");
  };

  const logError = (msg) => {
    stderr.write(`volary-mcp-proxy: ${msg}\n`);
  };

  const emitRpcError = (line, err) => {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && msg.id !== null) {
        writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32000,
              message: `volary proxy: ${err.message}`,
            },
          }),
        );
      }
    } catch {
      // original line wasn't parseable — nothing to respond to
    }
  };

  const handle = async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      logError(`bad JSON from stdin: ${e.message}`);
      return;
    }

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

    // Snoop the client's requested version AFTER building headers, so the
    // initialize request itself goes out without the header — matching the
    // spec's "use the negotiated version on subsequent requests".
    if (msg.method === "initialize" && msg.params?.protocolVersion) {
      protocolVersion = msg.params.protocolVersion;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: line,
      // Cap per-request time so a hung upstream surfaces as a JSON-RPC error
      // rather than a stuck inflight promise. Volary's MCP tools are fast
      // DB reads; 60s is well above the worst case.
      signal: AbortSignal.timeout(60_000),
    });

    // 202 Accepted: notifications / client responses, no body expected.
    if (resp.status === 202) return;

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();

    if (contentType.startsWith("text/event-stream")) {
      await relaySSE(resp, writeLine);
      return;
    }

    // Everything else we treat as a single JSON body. A spec-compliant MCP
    // server returns a JSON-RPC envelope (jsonrpc: "2.0", matching id),
    // including for errors. If the body isn't that shape — e.g. Volary's
    // auth layer returning {"error":"unauthorized"} on a 401 — we must
    // wrap it, otherwise Cursor can't match it to the pending request and
    // times out.
    const body = (await resp.text()).trim();
    if (!body) {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} with empty body`);
      return;
    }
    if (!contentType.includes("application/json") && !resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(
        `non-JSON response (HTTP ${resp.status}): ${body.slice(0, 200)}`,
      );
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.jsonrpc === "2.0"
    ) {
      writeLine(body);
      return;
    }
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  };

  const inflight = new Set();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const p = handle(trimmed).catch((err) => {
      logError(err.message);
      emitRpcError(trimmed, err);
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
  await Promise.allSettled(inflight);
}

// relaySSE reads an SSE stream and forwards each event's data payload to
// stdout as a single NDJSON line. A single SSE event may span multiple
// `data:` lines; per the SSE spec we join them with \n.
async function relaySSE(resp, writeLine) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushFrame = (frame) => {
    const dataLines = [];
    for (const raw of frame.split(/\r?\n/)) {
      if (raw.startsWith("data:")) {
        dataLines.push(raw.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    // Per SSE spec we join multi-line `data:` fields with \n. writeLine then
    // collapses those back to spaces — which is safe here because every
    // payload we relay is a JSON-RPC message (valid JSON, no literal
    // newlines). If that assumption ever breaks, this is the place to fix.
    writeLine(dataLines.join("\n"));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const delim = /\r?\n\r?\n/g;
    let m;
    while ((m = delim.exec(buffer)) !== null) {
      const frame = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      flushFrame(frame);
      delim.lastIndex = 0;
    }
    if (done) {
      if (buffer.trim()) flushFrame(buffer);
      return;
    }
  }
}

async function main() {
  let config;
  try {
    config = requireConfig(loadConfig());
  } catch (err) {
    process.stderr.write(`volary-mcp-proxy: ${err.message}\n`);
    process.exit(1);
  }
  const url = `${config.apiUrl}/v0/orgs/${config.orgId}/agents/${config.agentId}/v0/mcp`;
  await runProxy({
    url,
    token: config.token,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`volary-mcp-proxy: ${err.message}\n`);
    process.exit(1);
  });
}
