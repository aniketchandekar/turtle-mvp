FROM node:22-slim

# Install build dependencies for compiling better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root manifests and workspace configs
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Install dependencies across workspaces
RUN npm ci

# Copy sources for shared package, server, and knowledge base
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY kb ./kb

# Build knowledge base into sqlite database
RUN npm run kb:build -w @turtle/server

# Create data directory for persistent SQLite volume
RUN mkdir -p /app/apps/server/data

# Environment configuration
ENV NODE_ENV=production \
    PORT=8787 \
    TURTLE_DB_PATH=/app/apps/server/data/turtle.sqlite

EXPOSE 8787

# Start backend server
CMD ["npm", "run", "start", "-w", "@turtle/server"]
