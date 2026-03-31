# Nebula Agent Client

Remote agent client that connects to your Nebula server and runs Claude Code locally on your machine.

## Requirements

- Node.js 20+
- Claude Code CLI (auto-installed if missing)

## Install

```bash
# From the repo
cd agent-client
npm install
npm link

# Or using the install script
bash scripts/install.sh
```

## Setup

1. In Nebula web UI, open agent **Settings > General > Execution Mode > Remote**
2. Click **Generate Token** and copy it
3. Register:

```bash
nebula-agent register \
  --server http://192.168.31.26:8090 \
  --agent-id <your-agent-id> \
  --token <your-token>
```

4. Start:

```bash
nebula-agent start
```

## Commands

| Command | Description |
|---------|-------------|
| `nebula-agent register` | Save server connection config |
| `nebula-agent start` | Connect and wait for tasks |
| `nebula-agent status` | Show current config |
| `nebula-agent unregister` | Remove config |

## How It Works

1. Client connects to Nebula via WebSocket (`/ws/remote`)
2. Authenticates with the agent's remote token
3. Waits for execute commands from Nebula
4. Spawns Claude Code locally via `node-pty`
5. Returns results back to Nebula over WebSocket
6. Auto-reconnects on disconnect

The agent runs locally with full access to your machine's repos, tools, and CPU — while Nebula manages the chat UI, scheduling, and message history.

## Config

Stored at `~/.nebula-agent.json`. Working directory at `~/.nebula-agents/<agent-id>/`.
