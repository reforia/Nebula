#!/bin/sh
# Ensure HOME directories are accessible by the runtime user
mkdir -p "$HOME/.ssh" /data/orgs 2>/dev/null

# Validate encryption key — secrets vault is unusable without it
if [ -z "$NEBULA_ENCRYPTION_KEY" ]; then
  echo "[entrypoint] FATAL: NEBULA_ENCRYPTION_KEY is not set." >&2
  echo "[entrypoint] Generate one with: openssl rand -hex 32" >&2
  echo "[entrypoint] Add it to your .env file and restart." >&2
  exit 1
fi

# Add user-provided CLI runtimes to PATH
export PATH="/data/runtimes/bin:$PATH"

exec node src/server.js
