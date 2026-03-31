# Nebula Roadmap

Organized by category, prioritized high-to-low within each. Priority reflects impact on keeping the SaaS path open without over-investing prematurely.

## Legend
- **Priority**: Critical > High > Medium > Low
- **Cost**: High (~weeks) > Medium (~days) > Low (~hours) > Trivial
- **Status**: Done | In Progress | Planned

---

## 1. Execution Engine

The core architectural investment. Determines whether Nebula is locked to Claude Code CLI or becomes a multi-provider agent platform.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 1.1 | **Execution backend abstraction** | **Critical** | High | Planned | Define `ExecutionBackend` interface. CC CLI becomes one impl. Enables Claude API, OpenAI, etc. |
| 1.2 | Claude API backend | High | Medium | Planned | Direct API calls, no PTY. Full control over token usage, streaming, cost. |
| 1.3 | OpenAI / other provider support | Medium | Medium | Planned | Behind abstraction layer from 1.1 |
| 1.4 | Sandboxed execution per org | Medium | High | Planned | Container isolation for multi-tenant SaaS. Not needed for self-hosted. |

---

## 2. Data & Infrastructure

Foundation that everything else builds on. Migration system is the most urgent pain point.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 2.1 | **DB migration system** | **Critical** | Low | Planned | Numbered SQL files, `_migrations` table, run on startup. No more deleting DB on schema changes. |
| 2.2 | **Usage event logging** | **High** | Low | Planned | `usage_events` table recording every execution (org, agent, backend, tokens, cost, duration). Accumulate data now, build billing later. |
| 2.3 | Structured logging | Medium | Low | Planned | Replace `console.log` with structured JSON logs. Prep for observability. |
| 2.4 | Rate limiting | Medium | Low | Planned | `express-rate-limit` per user/org. Prevent abuse. |
| 2.5 | PostgreSQL support | Medium | Medium | Planned | Behind DB abstraction. Current SQL is standard enough. Needed for SaaS scale. |
| 2.6 | Job queue (Redis/BullMQ) | Low | Medium | Planned | Currently in-process queue. Needed for horizontal scaling. |
| 2.7 | Health check endpoint | Low | Trivial | Planned | `GET /health` for load balancers. |

---

## 3. Auth & Identity

Current JWT system works. Gaps are around user lifecycle and team collaboration.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 3.1 | **Team membership** | **High** | Medium | Planned | Multiple users per org with roles (owner, member, viewer). Currently 1 owner only. |
| 3.2 | Email verification | Medium | Low | Planned | Verify email on registration. Prevents spam accounts. |
| 3.3 | Password reset | Medium | Low | Planned | Forgot password flow via email. |
| 3.4 | OAuth/SSO (Google, GitHub) | Medium | Medium | Planned | Reduces signup friction. |
| 3.5 | System admin role | Medium | Low | Planned | Global admin for SaaS operator vs org owners. |

---

## 4. Security & Isolation

Incremental hardening. Container isolation is the big SaaS gate but not needed now.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 4.1 | Secrets management | Medium | Medium | Planned | API keys in custom skills are plaintext in DB. Encrypt at rest, mask in UI. |
| 4.2 | CSRF protection | Medium | Low | Planned | Token-based CSRF for state-changing endpoints. |
| 4.3 | Input sanitization audit | Medium | Low | Planned | Review all user inputs for injection vectors. |
| 4.4 | Container isolation per org | Medium | High | Planned | Needed for SaaS. Each org's agents in isolated containers. |

---

## 5. Billing & Metering

Not needed until SaaS launch, but 2.2 (usage logging) lays the data foundation.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 5.1 | Plan tiers / quotas | High | Low | Planned | Per-org limits on agents, storage, executions. Schema + enforcement. |
| 5.2 | Stripe integration | High | Medium | Planned | Subscription management, payment processing. |
| 5.3 | Usage metering | High | Medium | Planned | Aggregate usage_events into billable metrics. |
| 5.4 | Usage dashboard | Medium | Medium | Planned | Cost graphs per agent/org. Token usage visibility. |

---

## 6. Admin & Ops

Operational maturity for running Nebula as a service.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 6.1 | Audit log | Medium | Low | Planned | `audit_events` table. Who did what, when. |
| 6.2 | Observability (Prometheus, Sentry) | Medium | Medium | Planned | Metrics export, error tracking. |
| 6.3 | CDN for static assets | Low | Low | Planned | Serve frontend from CDN instead of Express. |

---

## 7. Product & UX

Differentiation features once the platform is stable.

| # | Feature | Priority | Cost | Status | Notes |
|---|---------|----------|------|--------|-------|
| 7.1 | Skill templates / marketplace | Medium | Medium | Planned | Pre-built skills users can install (Twitter, Slack, GitHub). |
| 7.2 | Agent templates | Medium | Low | Planned | Pre-configured agents for common roles. |
| 7.3 | Public API with API keys | Medium | Medium | Planned | Programmatic agent management for developers. |

---

## Critical Path (do now)

These three items unblock the most future work with the least investment:

1. **1.1 Execution backend abstraction** — unlocks multi-provider, removes CC CLI lock-in
2. **2.1 DB migration system** — stops the delete-DB-on-every-change pain
3. **2.2 Usage event logging** — accumulate data now, build billing/dashboards later

Everything else can wait until there's a concrete SaaS timeline.
