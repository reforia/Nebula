#!/bin/sh
# Ensure HOME directories are accessible by the runtime user
mkdir -p "$HOME/.claude" "$HOME/.ssh" /data/orgs 2>/dev/null
exec node src/server.js
