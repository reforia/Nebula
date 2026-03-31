#!/bin/bash
# Nebula Agent Client — one-line installer
# Usage: curl -fsSL <url>/install.sh | bash
#
# Or manually:
#   1. Extract the tarball
#   2. cd nebula-agent
#   3. npm install
#   4. npm link

set -e

INSTALL_DIR="${HOME}/.nebula-agent-client"

echo "Nebula Agent Client Installer"
echo "=============================="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js 20+ required (found $(node -v))"
  exit 1
fi

echo "Node.js $(node -v) found"

# Check/install Claude Code
if command -v claude &>/dev/null; then
  echo "Claude Code found: $(claude --version 2>/dev/null || echo 'installed')"
else
  echo "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code
fi

# Install from tarball if present in current dir, otherwise from the script's dir
if [ -f package.json ] && grep -q '"@nebula/agent-client"' package.json 2>/dev/null; then
  echo "Installing from current directory..."
  npm install
  npm link
else
  echo "Setting up in ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  # If a tarball is provided as argument
  if [ -n "$1" ] && [ -f "$1" ]; then
    tar xzf "$1" -C "$INSTALL_DIR"
  else
    echo "Error: Run this script from the agent-client directory, or pass a tarball path"
    exit 1
  fi
  cd "$INSTALL_DIR"
  npm install
  npm link
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. In Nebula UI: Agent Settings > Execution Mode > Remote > Generate Token"
echo "  2. Register:  nebula-agent register --server <nebula-url> --agent-id <id> --token <token>"
echo "  3. Start:     nebula-agent start"
