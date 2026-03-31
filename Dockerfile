FROM node:22-bookworm-slim AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim

# Install build tools for native modules + CLI tools agents will use
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    curl git jq openssh-client ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI and OpenCode CLI globally
RUN npm install -g @anthropic-ai/claude-code opencode-ai

# Create HOME directories writable by any user (UID set at runtime via docker-compose)
RUN mkdir -p /home/node/.claude /home/node/.ssh && chmod -R 777 /home/node

WORKDIR /app

# Install backend dependencies (builds native modules, then remove build tools)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && \
    apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    rm -rf /root/.npm /tmp/*

# Copy backend source
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY templates/ ./templates/
COPY CLAUDE.md ./

# Copy built frontend
COPY --from=frontend-build /build/frontend/dist ./frontend/dist/

# Create data directory writable by any user
RUN mkdir -p /data && chmod 777 /data

# Copy entrypoint
COPY scripts/entrypoint.sh /entrypoint.sh

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HOME=/home/node
ENV PORT=8080

EXPOSE 8080

CMD ["/entrypoint.sh"]
