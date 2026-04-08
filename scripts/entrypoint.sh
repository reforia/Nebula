#!/bin/sh
# Ensure HOME directories are accessible by the runtime user
mkdir -p "$HOME/.ssh" /data/orgs 2>/dev/null

# Add user-provided CLI runtimes to PATH
export PATH="/data/runtimes/bin:$PATH"

exec node src/server.js
