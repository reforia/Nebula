# Nebula

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.19437047.svg)](https://doi.org/10.5281/zenodo.19437047)

Self-hosted AI agent platform. Create, manage, and orchestrate multiple AI agents backed by persistent CLI sessions with cross-agent communication, custom skills, and scheduled tasks.

> **Paper:** [Nebula: Decoupling Agent Identity from Runtime in Multi-Agent LLM Systems](https://doi.org/10.5281/zenodo.19437047) (April 2026)
<img width="1302" height="808" alt="image" src="https://github.com/user-attachments/assets/3e266c0b-2f10-4b66-8651-f50fb99fdfe4" />
<img width="1084" height="537" alt="image" src="https://github.com/user-attachments/assets/c015bf8e-4ded-46a9-baf1-cc240c0d10ff" />

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
git clone https://github.com/reforia/Nebula.git
cd Nebula
cp .env.example .env

# Generate an encryption key
echo "NEBULA_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

docker compose up -d
```

Open `http://localhost:8080` — the setup wizard walks you through creating an admin account and detecting CLI runtimes.

### From Source

```bash
git clone https://github.com/reforia/Nebula.git
cd Nebula

npm install
cd frontend && npm install && npm run build && cd ..

# Create .env from the example, then generate an encryption key
cp .env.example .env
echo "NEBULA_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

DATA_DIR=./data npm start
```

> **Note:** `npm install` runs a postinstall script that fixes execute permissions on the `node-pty` spawn helper. If you see `posix_spawnp failed` errors, run `node scripts/postinstall.js` manually.

### Requirements

- **Node.js 22+** (if running from source)
- **At least one CLI runtime** installed in the container or host:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — **most actively supported**
  - [OpenCode](https://opencode.ai) (`opencode`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

> Claude Code is the primary development and testing target. Other runtimes are functional but may have rough edges — issues and PRs welcome.

## Feature Highlights
### Projects - Multi-Agent Collaboration with Git and External Resources
<p align="center">
<img width="1909" height="952" alt="image" src="https://github.com/user-attachments/assets/84e9da68-6a37-47fb-9fa8-a4d7f02c0981" />
</p>

### Template Hub
<p align="center">
<img width="507" height="870" alt="image" src="https://github.com/user-attachments/assets/b9084d7c-d91e-4925-8192-9773ae5033d3" />
</p>

### Multi CLI Runtime Support
<p align="center">
<img width="512" height="945" alt="image" src="https://github.com/user-attachments/assets/6fdfc4b5-a481-443f-ba21-f789ad516e53" />
</p>

### Secret Redaction
<p align="center">
<img width="510" height="939" alt="image" src="https://github.com/user-attachments/assets/8cd51e38-b066-49d3-b9cd-1e621a0b066f" />
</p>

### Auto Session Cleanup
<p align="center">
<img align="center" width="502" height="275" alt="image" src="https://github.com/user-attachments/assets/0eefba9f-5d8d-468d-9b86-9e81e7d2cf0b" />
</p>

### Agent Cross Communications - @Someone pulls them to conversation, @notify Someone tells someone about something
<p align="center">
<img width="290" height="270" alt="image" src="https://github.com/user-attachments/assets/55fccd10-b5b5-45d9-b054-830b345d6041" />
</p>

### Remove Agent Execution
<p align="center">
<img width="362" height="486" alt="image" src="https://github.com/user-attachments/assets/7a127518-0a41-4773-a7e0-c7e044c5031e" />
</p>

### And many, many more
Layered Memory Management, Soul/Body splition, Org - Agent - Project context aggregation, Webhook, MCP, etc. Full features can be found [here](https://nebula.enigmaetmt.com/docs)

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

All configuration is via environment variables. Copy `.env.example` to `.env` and edit as needed — both Docker and from-source setups read from it.

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `NEBULA_ENCRYPTION_KEY` | — | **Required.** AES-256 key for secrets vault. Generate with `openssl rand -hex 32`. |
| `NEBULA_PORT` | `8080` | HTTP port |
| `NEBULA_URL` | — | External URL of this instance (e.g. `http://your-server:8080`). Required for remote agents and built-in skills. |
| `NEBULA_DATA_DIR` | `./data` | Persistent data directory (SQLite database, agent workspaces, backups) |
| `RUNTIMES_DIR` | `./runtimes` | Directory for CLI runtime binaries. Place or symlink binaries into `runtimes/bin/` — auto-detected at startup. |
| `CLI_HOME_DIR` | `./cli-home` | Docker only. Persists CLI auth and config (`~/.claude`, `~/.config/gemini`, etc.) across container restarts. |
| `SSH_KEYS_DIR` | `./ssh-keys` | Docker only. Mounts SSH keys into the container (read-only). |
| `NEBULA_UID` / `NEBULA_GID` | `1000` | Docker only. Container user UID/GID — match your host user for correct file ownership. |
| `AUTH_PROVIDER` | `local` | Auth mode: `local` (email/password) or `enigma` (OAuth) |
| `TZ` | `UTC` | Timezone for cron schedules |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | HTTP proxy for outbound requests. `NO_PROXY` defaults to `localhost,127.0.0.1`. |

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

## Remote Agent App

Agents can run on external machines, connecting back to Nebula via WebSocket. The **Agent App** (`agent-app/`) is a Tauri desktop app for macOS and Windows.

### Building

Requires [Rust](https://rustup.rs/) and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
cd agent-app
npm install
npm run tauri dev    # Development
npm run tauri build  # Production binary (.dmg / .msi)
```

### Usage

1. In Nebula web UI, open agent **Settings > General > Execution Mode > Remote**
2. Click **Generate Token** and copy it
3. Open the Agent App, paste the server URL, agent ID, and token
4. The app connects via WebSocket and runs the CLI locally on your machine

## Security Model

Nebula runs all agents within a single Docker container. The container is the primary isolation boundary — agents cannot access the host filesystem or network beyond what Docker exposes.

**What's isolated:**
- Agents from the host (Docker container boundary)
- Agent data at rest (secrets encrypted with AES-256-GCM, write-only in UI)
- Inter-agent communication (routed through the platform via `@mention`, not direct access)
- Session auth errors (detected and surfaced immediately, no silent failures)

**Known limitation — shared filesystem within container:**

All agents in the same container share the same Linux user and filesystem namespace. An agent could theoretically read another agent's working directory or the SQLite database file. In practice, agents operate within their assigned working directories and interact with peers only through Nebula's routing layer. This is acceptable for single-owner deployments where you control all agents.

**If you need stronger isolation:**
- Run separate Nebula instances (one per trust boundary)
- Use the remote agent feature to run agents on dedicated machines
- Per-agent filesystem isolation via mount namespaces (bubblewrap) is tracked as a future enhancement

## License

[AGPL-3.0](LICENSE) — free to use, modify, and self-host. Network use requires source disclosure of modifications.
