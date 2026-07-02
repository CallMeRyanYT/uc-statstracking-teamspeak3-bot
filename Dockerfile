FROM node:20-slim

# Install Python and build tools needed for sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer-cached)
COPY package*.json ./
RUN npm install --omit=dev --no-audit

# Copy source
COPY src/ ./src/
COPY web/ ./web/

# Data directory for the SQLite database (mounted as a volume)
RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/server', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
