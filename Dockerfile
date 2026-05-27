# ─── Stage 1: Build ───────────────────────────────────────────────────────────
# node:24-bookworm-slim = Debian 12 (Bookworm) — fresher packages, works with Node 24
FROM node:24-bookworm-slim AS builder

# mediasoup worker needs Python 3, make, and g++ to compile its C++ binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first — Docker caches this layer and skips npm ci
# on rebuilds if package.json / package-lock.json haven't changed
COPY package.json package-lock.json ./

# Install deps + compile mediasoup native worker
RUN npm ci

# Copy rest of source
COPY . .


# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner

# mediasoup spawns its worker binary at runtime — python3 is NOT needed here,
# only the compiled binary that was copied from the builder stage
WORKDIR /app

# Create a non-root user BEFORE copying files so ownership is correct
RUN useradd -m appuser

# Copy compiled node_modules and app source from build stage
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/server.js   ./server.js
COPY --from=builder --chown=appuser:appuser /app/package.json ./package.json
COPY --from=builder --chown=appuser:appuser /app/public      ./public

# Switch to non-root user
USER appuser

# PORT: Express/Socket.io HTTP port (Render sets this automatically)
# 20000-20100: mediasoup RTC ports (open these in your VPS firewall)
ENV PORT=3000
EXPOSE ${PORT}
EXPOSE 20000-20100/udp
EXPOSE 20000-20100/tcp

CMD ["node", "server.js"]
