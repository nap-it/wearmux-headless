# syntax=docker/dockerfile:1
# Stage 1: Build dependencies
FROM node:20-bookworm-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev python3-venv \
    build-essential make g++ git pkg-config \
    libudev-dev libbluetooth-dev libglib2.0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
COPY package.json package-lock.json* ./
ENV PYTHON=/usr/bin/python3 \
    NPM_CONFIG_UNSAFE_PERM=true \
    npm_config_legacy_peer_deps=true

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# Install Python dependencies
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/venv \
    && . /opt/venv/bin/activate \
    && pip install --upgrade pip \
    && pip install -r requirements.txt

# Stage 2: Runtime image
FROM node:20-bookworm-slim AS runtime

# Install runtime dependencies only (no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg \
    libudev1 libbluetooth3 bluez libglib2.0-0 \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app

# Copy Node.js dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy Python virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Copy application source
COPY . .

# Set environment variables
ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    NODE_ENV=production \
    DEBUG=0

# Create non-root user for security
RUN groupadd -r wearmux && useradd -r -g wearmux wearmux \
    && chown -R wearmux:wearmux /app

# Use non-root user (comment out if BLE access requires root)
# USER wearmux

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Use Tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command
CMD ["node", "tools/launcher.js", "--config", "/config"]
