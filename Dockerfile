# Telemetry Ops Copilot: agent HTTP API + trace viewer on port 3000.
#   docker build -t telemetry-ops-copilot .
#   docker run --rm -p 3000:3000 telemetry-ops-copilot
#   docker run --rm -e ANTHROPIC_API_KEY=... -p 3000:3000 telemetry-ops-copilot   (real model)

# --- Stage 1: install production dependencies -------------------------------
# better-sqlite3 is a native module. If no prebuilt binary matches, npm
# compiles it, which needs Python and a C++ toolchain. Those tools stay in
# this stage and never reach the final image.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 2: runtime ---------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY runbooks ./runbooks
COPY viewer ./viewer
COPY fixtures ./fixtures

# Generate the synthetic fleet at build time (deterministic, ~2 s).
RUN npm run seed

# Run as the unprivileged "node" user that the base image provides.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "run", "serve"]
