#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig, CONFIG_PATH } from './lib/config.js';
import { detectAll } from './lib/cli-manager.js';
import { NebulaAgentClient } from './lib/client.js';

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`
Nebula Agent Client — run AI coding agents locally, connected to your Nebula server.

Usage:
  nebula-agent register --server <url> --agent-id <id> --token <token> [--work-dir <path>]
  nebula-agent start
  nebula-agent status
  nebula-agent unregister

Options:
  --server     Nebula server URL (e.g. http://your-server:8080)
  --agent-id   Agent ID from Nebula
  --token      Remote token (generated in agent settings)
  --work-dir   Working directory for this agent (default: ~/.nebula-agents/<agent-id>)

Examples:
  nebula-agent register --server http://your-server:8080 --agent-id abc-123 --token xyz-789
  nebula-agent start
`);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2).replace(/-/g, '_');
      parsed[key] = args[++i];
    }
  }
  return parsed;
}

async function cmdRegister() {
  const opts = parseArgs(args.slice(1));
  if (!opts.server || !opts.agent_id || !opts.token) {
    console.error('Error: --server, --agent-id, and --token are required');
    process.exit(1);
  }

  const workDir = opts.work_dir || path.join(os.homedir(), '.nebula-agents', opts.agent_id);
  fs.mkdirSync(workDir, { recursive: true });

  const config = {
    server: opts.server,
    agentId: opts.agent_id,
    token: opts.token,
    workDir,
  };

  saveConfig(config);
  console.log(`Registered successfully.`);
  console.log(`  Server:    ${config.server}`);
  console.log(`  Agent ID:  ${config.agentId}`);
  console.log(`  Work dir:  ${config.workDir}`);
  console.log(`  Config:    ${CONFIG_PATH}`);
  console.log(`\nRun "nebula-agent start" to connect.`);
}

async function cmdStart() {
  const config = loadConfig();
  if (!config) {
    console.error('No configuration found. Run "nebula-agent register" first.');
    process.exit(1);
  }

  console.log(`Nebula Agent Client`);
  console.log(`  Server:    ${config.server}`);
  console.log(`  Agent ID:  ${config.agentId}`);
  console.log(`  Work dir:  ${config.workDir}`);
  console.log('');

  // Detect all available CLI runtimes
  const detectedCLIs = detectAll();
  if (detectedCLIs.length === 0) {
    console.error('No CLI runtimes found. Install at least one:');
    console.error('  Claude Code: npm install -g @anthropic-ai/claude-code');
    console.error('  OpenCode:    npm install -g opencode-ai');
    process.exit(1);
  }
  console.log(`  Runtimes:  ${detectedCLIs.map(c => c.name).join(', ')}`);
  console.log('');

  // Ensure work directory exists
  fs.mkdirSync(config.workDir, { recursive: true });

  const client = new NebulaAgentClient({
    server: config.server,
    agentId: config.agentId,
    token: config.token,
    detectedCLIs,
    workDir: config.workDir,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[client] Shutting down...');
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.start();
}

function cmdStatus() {
  const config = loadConfig();
  if (!config) {
    console.log('Not registered. Run "nebula-agent register" first.');
    return;
  }
  console.log(`Registered agent:`);
  console.log(`  Server:    ${config.server}`);
  console.log(`  Agent ID:  ${config.agentId}`);
  console.log(`  Work dir:  ${config.workDir}`);
  console.log(`  Config:    ${CONFIG_PATH}`);

  const detectedCLIs = detectAll();
  console.log(`  Runtimes:  ${detectedCLIs.length > 0 ? detectedCLIs.map(c => `${c.name} (${c.path})`).join(', ') : 'none detected'}`);
}

function cmdUnregister() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
    console.log('Configuration removed.');
  } else {
    console.log('No configuration found.');
  }
}

switch (command) {
  case 'register': await cmdRegister(); break;
  case 'start': await cmdStart(); break;
  case 'status': cmdStatus(); break;
  case 'unregister': cmdUnregister(); break;
  default: usage(); break;
}
