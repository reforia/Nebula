#!/usr/bin/env node
/**
 * MCP stdio-to-HTTP bridge.
 *
 * Workaround for CC CLI's Bun runtime failing to connect to HTTP MCP servers.
 * CC CLI spawns this as a stdio MCP server; it forwards all JSON-RPC messages
 * to the real HTTP MCP server and pipes responses back.
 *
 * Usage: node mcp-http-bridge.js <url> [headers-json]
 *   e.g. node mcp-http-bridge.js http://host.docker.internal:3456/mcp '{"Authorization":"Bearer xxx"}'
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write('[mcp-bridge] Usage: mcp-http-bridge.js <url> [headers-json]\n');
  process.exit(1);
}
let extraHeaders = {};
if (process.argv[3]) {
  try { extraHeaders = JSON.parse(process.argv[3]); } catch {}
}

let sessionId = null;
let buf = '';
let queue = Promise.resolve();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) queue = queue.then(() => forward(line));
  }
});

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`[mcp-bridge] Invalid JSON: ${line.slice(0, 100)}\n`);
    return;
  }

  const isNotification = msg.id === undefined;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
    });
  } catch (err) {
    process.stderr.write(`[mcp-bridge] Fetch error: ${err.message}\n`);
    if (!isNotification) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: `Bridge fetch failed: ${err.message}` },
      }) + '\n');
    }
    return;
  }

  // Capture session ID from init response
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  // Notifications return 202 with no body
  if (res.status === 202) return;

  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();

  if (contentType.includes('text/event-stream')) {
    // Parse SSE: extract "data:" lines
    for (const sse of body.split('\n')) {
      if (sse.startsWith('data: ')) {
        process.stdout.write(sse.slice(6) + '\n');
      }
    }
  } else {
    // Plain JSON response
    process.stdout.write(body + '\n');
  }
}

process.stderr.write(`[mcp-bridge] Bridging stdio ↔ ${url}\n`);
