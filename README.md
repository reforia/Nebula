# Nebula

Self-hosted AI agent platform. Create, manage, and orchestrate multiple AI agents backed by persistent CLI sessions with cross-agent communication, custom skills, and scheduled tasks.

## Features

- **Multi-agent management** — Create agents with distinct roles, knowledge, and tool access. Each agent runs in its own persistent CLI session.
- **Cross-agent routing** — `@mention` agents in conversations to pull them into collaborative threads. Agents can reference each other's work.
- **Custom skills** — Teach agents new capabilities via user-defined skills (API integrations, workflows). Org-wide or agent-specific.
- **MCP server support** — Connect agents to external tool APIs via Model Context Protocol. Org-wide or per-agent.
- **Persistent memory** — API-managed agent memory with BM25 search. Agents build knowledge across conversations.
- **Scheduled tasks** — Cron-based and webhook-triggered task execution. Agents run autonomously on schedule.
- **Projects** — Multi-agent git coordination with milestones, deliverables, and branch-isolated workspaces.
- **Remote agents** — Run agents on external machines via WebSocket bridge (desktop app or headless CLI client).
- **Multi-backend** — Supports Claude Code CLI, OpenCode, Codex CLI, and Gemini CLI as execution backends.
- **Secrets vault** — Write-only encrypted secrets at org and agent scope. Referenced as `{{KEY}}` in skills and configs.
- **Multi-user / multi-org** — Local email/password auth. Each user owns organizations that scope agents, settings, and data.

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/enigma-labs/Nebula.git
cd Nebula
cp .env.example .env

# Generate an encryption key
echo "NEBULA_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

docker compose up -d
```

Open `http://localhost:8080` — the setup wizard walks you through creating an admin account and detecting CLI runtimes.

### From Source

```bash
git clone https://github.com/enigma-labs/Nebula.git
cd Nebula

npm install
cd frontend && npm install && npm run build && cd ..

DATA_DIR=./data npm start
```

### Requirements

- **Node.js 22+** (if running from source)
- **At least one CLI runtime** installed in the container or host:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [OpenCode](https://opencode.ai) (`opencode`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

## Architecture

Single container: Node.js 22, Express backend, React frontend (served as static), SQLite via better-sqlite3.

```
User (email/password auth)
 └── Organization
      ├── Agents (each with own CLI session)
      │    ├── Conversations
      │    ├── Tasks (cron / webhook)
      │    ├── Custom Skills
      │    ├── Secrets
      │    ├── MCP Servers
      │    └── Memories
      ├── Projects (multi-agent git coordination)
      ├── Custom Skills (org-wide)
      ├── MCP Servers (org-wide)
      └── Secrets Vault (org-wide)
```

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_PROVIDER` | `local` | Auth mode: `local` (email/password) or `enigma` (OAuth) |
| `NEBULA_PORT` | `8080` | HTTP port |
| `NEBULA_DATA_DIR` | `./data` | Persistent data directory |
| `NEBULA_ENCRYPTION_KEY` | — | AES-256 key for secrets vault (required) |
| `TZ` | `UTC` | Timezone for cron schedules |

## CLI Runtime Registry

Agents execute via pluggable CLI adapters. No CLI is hardcoded — adding a new runtime is one adapter file + one line of registration. See [`docs/ADDING_CLI_RUNTIMES.md`](docs/ADDING_CLI_RUNTIMES.md).

## Development

```bash
# Backend with local data directory
DATA_DIR=./data npm run dev

# Frontend dev server (proxies to backend on :8080)
cd frontend && npm run dev

# Run tests
npm test
```

## Deploying

### Docker Compose

```bash
docker compose up -d
```

### Custom Server

Use `scripts/deploy.sh` for tarball-based deployment to a remote server:

```bash
NAS_HOST=user@your-server NAS_SSH_PORT=22 bash scripts/deploy.sh
```

## Remote Agent Apps

Agents can run on external machines, connecting back to Nebula via WebSocket:

- **Agent App** (`agent-app/`) — Tauri desktop app (macOS, Windows) with GUI
- **Agent Client** (`agent-client/`) — Headless CLI client for servers

## License

[AGPL-3.0](LICENSE) — free to use, modify, and self-host. Network use requires source disclosure of modifications.
