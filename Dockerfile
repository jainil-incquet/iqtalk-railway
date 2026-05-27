# ─── Stage 1: Build ───────────────────────────────────────────────────────────
# Use a full Node image with build tools so mediasoup can compile its C++ worker
FROM node:24-bullseye-slim AS builder

# mediasoup worker needs Python 3, make, g++, and pip to compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (Docker layer cache — only re-installs if these change)
COPY package.json package-lock.json ./

# Install all dependencies and compile mediasoup native worker
RUN npm ci

# Copy rest of source
COPY . .


# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
# Slim image for the actual running container
FROM node:24-bullseye-slim AS runner

# mediasoup worker binary needs these at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what's needed from the build stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

# The port your Express/Socket.io server listens on
# Render sets PORT env var automatically; default to 3000 locally
ENV PORT=3000

# RTC port range for mediasoup WebRTC transports
# On a real VPS, open these in your firewall: UDP/TCP 20000-20100
EXPOSE ${PORT}
EXPOSE 20000-20100/udp
EXPOSE 20000-20100/tcp

# Run as non-root for security
RUN useradd -m appuser
USER appuser

CMD ["node", "server.js"]
