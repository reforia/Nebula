# Contributing to Nebula

Thank you for your interest in contributing. Nebula is an early-stage research project — contributions should be focused, purposeful, and aligned with the core architecture.

## Before You Start

- Check open issues and PRs to avoid duplicating work.
- For non-trivial changes, open an issue first to discuss scope and approach.
- Read the paper draft (`docs/`) to understand the soul/body separation architecture before modifying core agent lifecycle code.

## Development Setup

```bash
cp .env.example .env          # configure your local env
npm install
docker-compose up -d          # starts supporting services
npm run dev
```

## Conventions

- **Node.js** — ES modules, async/await throughout, no callback hell.
- **Commits** — conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- **PRs** — one concern per PR. Fill in the PR template fully.
- **Tests** — add or update tests for any changed behaviour. Run `npm test` before pushing.
- **No secrets** — never commit `.env` files, tokens, or credentials.

## Architecture Boundaries

| Layer | Responsibility |
|-------|---------------|
| `src/` | Core runtime — agent identity, soul/body lifecycle, message routing |
| `agent-app/` | Agent application logic |
| `agent-client/` | Client SDK |
| `frontend/` | Dashboard UI |
| `migrations/` | DB schema — treat as append-only |

Changes to `src/` or `migrations/` require extra scrutiny and a clear rationale.

## Pull Request Process

1. Branch from `main`: `git checkout -b feat/your-feature`
2. Keep PRs small and focused.
3. Ensure `npm test` passes locally.
4. Fill in the PR template.
5. Request review from @reforia.

## Reporting Bugs

Use the Bug Report issue template. Include reproduction steps, environment details, and relevant logs.

## Code of Conduct

Be direct, respectful, and constructive. We ship things we love first.