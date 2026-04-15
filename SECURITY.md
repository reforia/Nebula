# Security Policy

## Supported Versions

Nebula is currently in private beta. Security fixes will be applied to the latest `main` branch only.

| Version | Supported |
|---------|-----------|
| main (latest) | Yes |
| older commits | No |

## Reporting a Vulnerability

**Do not file a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing the maintainer directly (see GitHub profile). Include:

- A clear description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations

You can expect an acknowledgement within 48 hours and a status update within 7 days.

## Scope

In-scope:
- Authentication and session handling
- Agent identity isolation (soul/body separation)
- Multi-tenant data leakage
- Privilege escalation between agents or organisations
- Injection vulnerabilities (SQL, command, prompt injection with data exfiltration impact)

Out-of-scope:
- Denial of service on self-hosted instances
- Issues requiring physical access to the host
- Social engineering

## Disclosure Policy

We follow responsible disclosure. Once a fix is deployed, we will credit the reporter in the release notes (unless they prefer to remain anonymous).