FROM node:20-bookworm-slim AS base

# Install Python3 and pip for the Python sidecar
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev python3-venv \
    build-essential make g++ git pkg-config \
    libudev-dev libbluetooth-dev bluez libglib2.0-dev \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first (cache layer)
COPY package.json package-lock.json* ./
ENV PYTHON=/usr/bin/python3 \
    NPM_CONFIG_UNSAFE_PERM=true \
    npm_config_legacy_peer_deps=true \
    npm_config_sharp_binary_host="https://npmmirror.com/mirrors/sharp"
RUN npm ci || npm install --no-audit --no-fund --legacy-peer-deps

# Install Python deps into a virtual environment
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && . /opt/venv/bin/activate \
    && pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Expose venv in PATH for runtime tools
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy source
COPY . .

# Default envs
ENV ZENOH_ENABLE=0 \
    NODE_ENV=production

# Use Tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Launcher reads config.ini and runs scripts
CMD ["node", "tools/launcher.js", "--config", "/config/config.ini"]
