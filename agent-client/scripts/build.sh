#!/bin/bash
# Package the agent client as a tarball for distribution
set -e
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Packaging nebula-agent v${VERSION}..."

mkdir -p dist

# Create tarball with all source files (no node_modules — installed on target)
tar czf "dist/nebula-agent-${VERSION}.tar.gz" \
  --exclude=node_modules --exclude=dist --exclude=scripts/build.sh \
  .

echo "Created dist/nebula-agent-${VERSION}.tar.gz"
ls -lh "dist/nebula-agent-${VERSION}.tar.gz"
