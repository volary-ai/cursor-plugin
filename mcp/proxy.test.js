import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runProxy } from "./proxy.js";

// Helper: construct a mock fetch that records calls and returns a canned
// response. `body` may be a string (Content-Type application/json) or an
// iterable of SSE chunks (Content-Type text/event-stream).
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function emptyResponse(status) {
  return new Response(null, { status });
}

// Drive runProxy with `inputs` piped in, wait for it to drain, and return
// { stdout, stderr, fetchCalls }.
async function drive({ inputs, fetch }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks = [];
  const errChunks = [];
  stdout.on("data", (c) => outChunks.push(c));
  stderr.on("data", (c) => errChunks.push(c));

  const done = runProxy({
    url: "http://example.test/mcp",
    token: "tok",
    stdin,
    stdout,
    stderr,
    fetch,
  });

  for (const line of inputs) {
    stdin.write(line + "\n");
  }
  stdin.end();

  await done;

  return {
    stdout: Buffer.concat(outChunks).toString("utf-8"),
    stderr: Buffer.concat(errChunks).toString("utf-8"),
    fetchCalls: fetch.calls,
  };
}

function linesOf(s) {
  return s.split("\n").filter((l) => l.length > 0);
}

test("forwards a JSON response to stdout as one NDJSON line", async () => {
  const fetch = mockFetch(() =>
    jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { ok: true } }),
  );
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const { stdout, stderr, fetchCalls } = await drive({
    inputs: [req],
    fetch,
  });

  assert.equal(stderr, "");
  const lines = linesOf(stdout);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  });

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "http://example.test/mcp");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Authorization"], "Bearer tok");
  assert.equal(
    call.init.headers["Accept"],
    "application/json, text/event-stream",
  );
  assert.equal(call.init.body, req);
});

test("forwards SSE events as separate NDJSON lines", async () => {
  const frames = [
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"n":1}}\n\n',
    'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
  ];
  const fetch = mockFetch(() => sseResponse(frames));
  const req = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });

  assert.equal(stderr, "");
  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].method, "notifications/progress");
  assert.equal(lines[1].id, 7);
});

test("handles SSE frames that arrive split across chunks", async () => {
  const frames = [
    'data: {"jsonrpc":"2.0","id":1,',
    '"result":{"ok":true}}\n\n',
  ];
  const fetch = mockFetch(() => sseResponse(frames));
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });

  const { stdout } = await drive({ inputs: [req], fetch });
  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 1);
});

test("joins multi-line data fields with \\n per SSE spec", async () => {
  const frames = ["data: line1\ndata: line2\n\n"];
  const fetch = mockFetch(() => sseResponse(frames));
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });

  const { stdout } = await drive({ inputs: [req], fetch });
  // runProxy strips embedded newlines before writing — they become spaces.
  // The important thing is we didn't lose either data line.
  assert.match(stdout, /line1/);
  assert.match(stdout, /line2/);
});

test("drops 202 Accepted responses with no output", async () => {
  const fetch = mockFetch(() => emptyResponse(202));
  const req = JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });

  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("adds MCP-Protocol-Version header after initialize", async () => {
  const fetch = mockFetch(() =>
    jsonResponse(200, { jsonrpc: "2.0", id: 1, result: {} }),
  );
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const next = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const { fetchCalls } = await drive({ inputs: [init, next], fetch });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].init.headers["MCP-Protocol-Version"], undefined);
  assert.equal(
    fetchCalls[1].init.headers["MCP-Protocol-Version"],
    "2025-06-18",
  );
});

test("emits JSON-RPC error and logs to stderr on fetch failure", async () => {
  const fetch = mockFetch(() => {
    throw new Error("boom");
  });
  const req = JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });

  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 42);
  assert.ok(lines[0].error);
  assert.match(lines[0].error.message, /boom/);
  assert.match(stderr, /boom/);
});

test("does not emit a JSON-RPC error for notifications (no id)", async () => {
  const fetch = mockFetch(() => {
    throw new Error("nope");
  });
  const req = JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });

  assert.equal(stdout, "");
  assert.match(stderr, /nope/);
});

test("surfaces non-OK non-JSON response as a JSON-RPC error", async () => {
  const fetch = mockFetch(
    () =>
      new Response("internal error text", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
  );
  const req = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });
  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 5);
  assert.match(lines[0].error.message, /500/);
  assert.match(stderr, /500/);
});

test("forwards JSON error bodies unchanged (e.g. 401)", async () => {
  const fetch = mockFetch(
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          error: { code: -32001, message: "unauthorized" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  const req = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });
  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].error.message, "unauthorized");
  assert.equal(stderr, "");
});

test("wraps non-JSON-RPC JSON error bodies as JSON-RPC errors", async () => {
  // Reproduces the real 401 from Volary's auth layer: a JSON body that is
  // not a JSON-RPC envelope. If we passed this through verbatim Cursor
  // would hang until timeout because it can't match it to any request id.
  const fetch = mockFetch(
    () =>
      new Response(
        JSON.stringify({ error: "unauthorized", source: "volary" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  const req = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" });

  const { stdout, stderr } = await drive({ inputs: [req], fetch });
  const lines = linesOf(stdout).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].jsonrpc, "2.0");
  assert.equal(lines[0].id, 11);
  assert.ok(lines[0].error, "expected error envelope");
  assert.match(lines[0].error.message, /401/);
  assert.match(lines[0].error.message, /unauthorized/);
  assert.match(stderr, /401/);
});
