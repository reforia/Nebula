#!/bin/bash
# Deploy Nebula to a remote server via SSH + Docker
# Usage: ./scripts/deploy.sh
#
# Configure via environment variables or edit the defaults below:
#   NAS_HOST        — SSH target (user@host)
#   NAS_SSH_PORT    — SSH port
#   NAS_DEPLOY_DIR  — Remote directory containing docker-compose.yml
#   DOCKER_BIN      — Path to docker binary on remote host

set -e

NAS="${NAS_HOST:?Set NAS_HOST (e.g. user@192.168.1.100)}"
NAS_PORT="${NAS_SSH_PORT:-22}"
NAS_DIR="${NAS_DEPLOY_DIR:-/opt/nebula}"
DOCKER="${DOCKER_BIN:-docker}"

echo "[0/4] Pre-flight checks..."
# Verify .env exists on target with encryption key
ENV_CHECK=$(ssh -p $NAS_PORT $NAS "
  if [ ! -f $NAS_DIR/.env ]; then
    echo 'MISSING_ENV'
  elif ! grep -q 'NEBULA_ENCRYPTION_KEY=.\+' $NAS_DIR/.env 2>/dev/null; then
    echo 'MISSING_KEY'
  else
    echo 'OK'
  fi
")
if [ "$ENV_CHECK" = "MISSING_ENV" ]; then
  echo "ERROR: No .env file at $NAS_DIR/.env on remote server." >&2
  echo "  Copy .env.example and configure it first:" >&2
  echo "  scp -O -P $NAS_PORT .env.example $NAS:$NAS_DIR/.env" >&2
  exit 1
elif [ "$ENV_CHECK" = "MISSING_KEY" ]; then
  echo "ERROR: NEBULA_ENCRYPTION_KEY is not set in $NAS_DIR/.env" >&2
  echo "  Generate one: openssl rand -hex 32" >&2
  exit 1
fi

echo "[1/4] Building frontend..."
cd "$(dirname "$0")/.."
(cd frontend && npm run build) 2>&1 | tail -3

echo "[2/4] Packaging..."
tar czf /tmp/nebula-deploy.tar.gz \
  --exclude=node_modules --exclude=data --exclude=.git --exclude=.gitea \
  --exclude=frontend/node_modules --exclude=.claude --exclude='*.tsbuildinfo' \
  --exclude=.env --exclude=docker-compose.override.yml .

echo "[3/4] Uploading to server..."
scp -O -P $NAS_PORT /tmp/nebula-deploy.tar.gz $NAS:$NAS_DIR/nebula-deploy.tar.gz

echo "[4/4] Building & restarting on server..."
ssh -p $NAS_PORT $NAS "
  cd $NAS_DIR
  tar xzf nebula-deploy.tar.gz 2>/dev/null
  # Kill any previous builds (but not our own shell)
  for pid in \$(pgrep -f 'docker compose build' 2>/dev/null); do kill \$pid 2>/dev/null; done
  sleep 1
  nohup sh -c '$DOCKER compose build > /tmp/nebula-build.log 2>&1 && $DOCKER compose up -d >> /tmp/nebula-build.log 2>&1 && echo DONE >> /tmp/nebula-build.log' &
  echo 'Build started in background. Check with:'
  echo '  ssh -p $NAS_PORT $NAS \"tail -f /tmp/nebula-build.log\"'
"

echo ""
echo "Deploy kicked off. Monitor build:"
echo "  ssh -p $NAS_PORT $NAS \"tail -f /tmp/nebula-build.log\""
echo ""
echo "Check status after build:"
echo "  ssh -p $NAS_PORT $NAS \"$DOCKER logs --tail 5 nebula\""
