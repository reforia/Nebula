#!/usr/bin/env node
/**
 * Minimal MCP test server — zero dependencies, raw JSON-RPC 2.0.
 *
 * Usage:
 *   node mcp-test-server.js              # stdio mode (for local agents)
 *   node mcp-test-server.js --http 3456  # HTTP Streamable mode (for network access)
 *
 * Tools:
 *   ping        — returns "pong" + timestamp
 *   echo        — returns the input message
 *   server_info — returns hostname, pid, transport, platform
 */

import os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const httpIdx = args.indexOf('--http');
const httpMode = httpIdx !== -1;
const httpPort = httpMode ? parseInt(args[httpIdx + 1] || '3456', 10) : null;

// ---------- Tool definitions ----------

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong with a timestamp — basic connectivity check',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'echo',
    description: 'Echoes back the input message — verifies parameter passing',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to echo back' } },
      required: ['message'],
    },
  },
  {
    name: 'server_info',
    description: 'Returns server environment details',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, params) {
  switch (name) {
    case 'ping':
      return { content: [{ type: 'text', text: `pong @ ${new Date().toISOString()}` }] };
    case 'echo':
      return { content: [{ type: 'text', text: params.message ?? '' }] };
    case 'server_info':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            hostname: os.hostname(), pid: process.pid,
            transport: httpMode ? `http:${httpPort}` : 'stdio',
            platform: os.platform(), arch: os.arch(),
            node: process.version, uptime_s: Math.floor(process.uptime()),
          }, null, 2),
        }],
      };
    default:
      return null;
  }
}

// ---------- JSON-RPC dispatch ----------

function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — acknowledge silently
  if (id === undefined) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'nebula-test', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const result = callTool(params?.name, params?.arguments ?? {});
      if (!result) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } };
      }
      return { jsonrpc: '2.0', id, result };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ---------- stdio transport ----------

function startStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    // MCP stdio uses newline-delimited JSON
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resp = handleMessage(msg);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
        }) + '\n');
      }
    }
  });
  process.stderr.write('[mcp-test-server] stdio mode ready\n');
}

// ---------- HTTP Streamable transport ----------

function startHttp() {
  // Track sessions for stateful Streamable HTTP
  const sessions = new Map(); // sessionId -> true

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${httpPort}`);

    // Health endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'http', port: httpPort, sessions: sessions.size }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // DELETE — session termination
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid && sessions.has(sid)) {
        sessions.delete(sid);
        res.writeHead(200);
      } else {
        res.writeHead(400);
      }
      res.end();
      return;
    }

    // GET — SSE stream (we don't push server-initiated events, just keep-alive)
    if (req.method === 'GET') {
      const accept = req.headers['accept'] || '';
      if (!accept.includes('text/event-stream')) {
        res.writeHead(406);
        res.end('Must accept text/event-stream');
        return;
      }
      const sid = req.headers['mcp-session-id'];
      if (!sid || !sessions.has(sid)) {
        res.writeHead(400);
        res.end('Invalid session');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Keep connection open; client will close when done
      req.on('close', () => res.end());
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    // POST — JSON-RPC request
    const accept = req.headers['accept'] || '';
    if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
      res.writeHead(406, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'Not Acceptable: Client must accept application/json or text/event-stream' },
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const isInit = body.method === 'initialize';

    // Session validation
    if (!isInit && (!sessionId || !sessions.has(sessionId))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: body.id ?? null,
        error: { code: -32000, message: 'Bad request: missing or invalid session' },
      }));
      return;
    }

    const resp = handleMessage(body);

    // Notifications return 202 with no body
    if (!resp) {
      res.writeHead(202);
      res.end();
      return;
    }

    // For init, create a session and return the session ID header
    if (isInit) {
      const newSid = randomUUID();
      sessions.set(newSid, true);
      console.error(`[mcp-test-server] session created: ${newSid}`);

      if (accept.includes('text/event-stream')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'mcp-session-id': newSid,
        });
        res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': newSid });
        res.end(JSON.stringify(resp));
      }
      return;
    }

    // Regular responses
    if (accept.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    }
  });

  server.listen(httpPort, '0.0.0.0', () => {
    console.error(`[mcp-test-server] HTTP mode on 0.0.0.0:${httpPort} (MCP endpoint: /mcp, health: /health)`);
  });

  process.on('SIGINT', () => { sessions.clear(); process.exit(0); });
}

// ---------- Main ----------

if (httpMode) {
  startHttp();
} else {
  startStdio();
}
