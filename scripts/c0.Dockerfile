FROM node:22-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 make g++ && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild better-sqlite3
COPY source/ /opt/source/
RUN git -C /opt/source init && git -C /opt/source add --force .
USER node
WORKDIR /tmp
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp/home", "TMPDIR=/tmp", "LANG=C.UTF-8", "TZ=UTC", "CI=1", "NODE_ENV=test", "NEXT_TELEMETRY_DISABLED=1", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1", "NEXTAUTH_URL=http://127.0.0.1:3000", "NEXTAUTH_SECRET=c0-disposable-secret-not-for-production", "AUTH_PASSWORD=c0-disposable-password", "INTERNAL_API_SECRET=c0-disposable-internal-secret", "LINKI_DB_PATH=/tmp/c0-fallback.db", "APP_VERSION=dev", "node", "/opt/source/scripts/c0-check.mjs"]
