import os from 'os';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { spawnCLI } from './executor.js';
import { getBinary } from './cli-manager.js';

export class NebulaAgentClient {
  /**
   * @param {Object} opts
   * @param {string} opts.server - Nebula server URL
   * @param {string} opts.agentId - Agent ID
   * @param {string} opts.token - Remote auth token
   * @param {{ id: string, path: string }[]} opts.detectedCLIs - Available runtimes from detectAll()
   * @param {string} opts.workDir - Working directory
   */
  constructor({ server, agentId, token, detectedCLIs, workDir }) {
    this.server = server;
    this.agentId = agentId;
    this.token = token;
    this.detectedCLIs = detectedCLIs;
    this.workDir = workDir;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.heartbeatInterval = null;
    this.running = true;
    this.busy = false;
    this.abortController = null;
  }

  start() {
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    clearInterval(this.heartbeatInterval);
    if (this.ws) this.ws.close();
  }

  _connect() {
    if (!this.running) return;

    const protocol = this.server.startsWith('https') ? 'wss' : 'ws';
    const host = this.server.replace(/^https?:\/\//, '');
    const url = `${protocol}://${host}/ws/remote`;

    console.log(`[client] Connecting to ${url}...`);

    const wsOptions = {};
    if (process.env.NEBULA_AGENT_INSECURE === '1') {
      wsOptions.rejectUnauthorized = false;
    }
    this.ws = new WebSocket(url, wsOptions);

    this.ws.on('open', () => {
      console.log('[client] Connected, authenticating...');
      this.reconnectDelay = 1000;
      this._send({
        type: 'auth',
        agent_id: this.agentId,
        token: this.token,
        device: this._collectDeviceInfo(),
        available_runtimes: this.detectedCLIs.map(c => c.id),
      });
    });

    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._handleMessage(msg);
    });

    this.ws.on('close', (code, reason) => {
      clearInterval(this.heartbeatInterval);
      console.log(`[client] Disconnected (${code}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
      if (this.running) {
        setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[client] WebSocket error:', err.message);
    });
  }

  _collectDeviceInfo() {
    const info = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      cpu: os.cpus()?.[0]?.model || 'unknown',
      cores: os.cpus()?.length || 0,
      ram: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`,
    };

    try {
      if (os.platform() === 'darwin') {
        info.gpu = execSync('system_profiler SPDisplaysDataType -detailLevel mini 2>/dev/null | grep "Chipset Model" | head -1 | sed "s/.*: //"', { encoding: 'utf-8' }).trim() || undefined;
      } else if (os.platform() === 'win32') {
        info.gpu = execSync('wmic path win32_VideoController get name /value 2>nul | findstr Name', { encoding: 'utf-8' }).replace('Name=', '').trim() || undefined;
      } else {
        info.gpu = execSync('lspci 2>/dev/null | grep -i vga | head -1 | sed "s/.*: //"', { encoding: 'utf-8' }).trim() || undefined;
      }
    } catch {}

    const toolchains = [];
    const checks = [
      ['node', 'node --version'],
      ['python', 'python3 --version 2>/dev/null || python --version 2>/dev/null'],
      ['go', 'go version'],
      ['rustc', 'rustc --version'],
      ['java', 'java -version 2>&1 | head -1'],
      ['dotnet', 'dotnet --version'],
      ['git', 'git --version'],
    ];
    for (const [name, cmd] of checks) {
      try {
        execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
        toolchains.push(name);
      } catch {}
    }
    if (toolchains.length > 0) info.toolchains = toolchains.join(', ');

    return info;
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        console.log(`[client] Authenticated as "${msg.agent.name}" (${msg.agent.id})`);
        console.log('[client] Waiting for tasks...');
        this.heartbeatInterval = setInterval(() => {
          this._send({ type: 'heartbeat' });
        }, 30000);
        break;

      case 'auth_failed':
        console.error(`[client] Auth failed: ${msg.error}`);
        this.running = false;
        this.ws.close();
        break;

      case 'execute':
        this._handleExecute(msg);
        break;

      case 'cancel':
        if (this.abortController) {
          console.log('[client] Cancelling running execution...');
          this.abortController.abort();
        }
        break;

      case 'heartbeat_ack':
        break;

      default:
        console.log(`[client] Unknown message type: ${msg.type}`);
    }
  }

  async _handleExecute(msg) {
    const { request_id } = msg;
    const runtime = msg.runtime || 'claude-cli';
    console.log(`[client] Executing request ${request_id.slice(0, 8)} (runtime: ${runtime})...`);
    this.busy = true;
    this.abortController = new AbortController();

    try {
      const binary = getBinary(runtime, this.detectedCLIs);
      const result = await spawnCLI(binary, runtime, msg, this.workDir, this.abortController.signal);
      this._send({ type: 'result', request_id, result });
      console.log(`[client] Request ${request_id.slice(0, 8)} completed (${result.duration_ms}ms, $${result.total_cost_usd?.toFixed(4) || '?'})`);
    } catch (err) {
      console.error(`[client] Request ${request_id.slice(0, 8)} failed:`, err.message);
      this._send({ type: 'error', request_id, error: err.message });
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }
}
