# Telemetry Ops Copilot: agent HTTP API + trace viewer on port 3000.
#   docker build -t telemetry-ops-copilot .
#   docker run --rm -p 3000:3000 telemetry-ops-copilot
#   docker run --rm -e ANTHROPIC_API_KEY=... -p 3000:3000 telemetry-ops-copilot   (real model)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so this layer is cached between code changes.
# better-sqlite3 ships prebuilt binaries for linux/glibc, so no compiler is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY runbooks ./runbooks
COPY viewer ./viewer
COPY fixtures ./fixtures
COPY tsconfig.json ./

# Generate the synthetic fleet at build time (deterministic, ~2 s).
RUN npm run seed

# Run as the unprivileged "node" user that the base image provides.
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "run", "serve"]
