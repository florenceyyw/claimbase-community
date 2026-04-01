# Claimbase — Self-Hosted Deployment Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Environment Variables](#environment-variables)
4. [Database Setup](#database-setup)
5. [Object Storage Setup](#object-storage-setup)
6. [Telegram Bot Setup](#telegram-bot-setup)
7. [AI Receipt Parsing Setup](#ai-receipt-parsing-setup)
8. [Building the Application](#building-the-application)
9. [Running in Production](#running-in-production)
10. [Reverse Proxy (nginx)](#reverse-proxy-nginx)
11. [Docker Deployment](#docker-deployment)
12. [Telegram Mini App Setup](#telegram-mini-app-setup)
13. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Claimbase has two main components:

| Component | Description | Directory |
|-----------|-------------|-----------|
| **API Server** | Express 5 REST API + Telegram bot (polling) + cron scheduler | `artifacts/api-server/` |
| **Web Portal** | React 19 + Vite SPA (Telegram Mini App or standalone) | `artifacts/web-portal/` |

In production, the **web portal** is built as static files and served by either:
- The API server itself (recommended — single process), or
- A separate static file server / CDN

The **API server** handles:
- REST API on `/api/*`
- Telegram bot (long-polling, no webhook setup needed)
- Cron scheduler (monthly reminders, cut-off processing)
- Object storage for receipt images and generated claim files

---

## Prerequisites

- **Node.js** ≥ 22 (built with Node.js 24; 22+ works)
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **PostgreSQL** ≥ 14
- **Google Cloud Storage bucket** (for receipt images and generated files) — or any S3-compatible storage with a GCS adapter
- A **Telegram Bot** (created via [@BotFather](https://t.me/BotFather))
- An **OpenAI-compatible API** for receipt parsing (OpenAI, Azure OpenAI, or any compatible proxy)

---

## Environment Variables

Create a `.env` file in the project root (or set these in your deployment platform):

```bash
# ── Required ──────────────────────────────────────────────

# PostgreSQL connection string
DATABASE_URL=postgresql://user:password@localhost:5432/claimbase

# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# JWT signing secret (any random string, 32+ chars recommended)
INTERNAL_API_SECRET=your-random-secret-string-here-change-me

# Port for the API server
PORT=3000

# ── Object Storage ────────────────────────────────────────

# Google Cloud Storage bucket ID
DEFAULT_OBJECT_STORAGE_BUCKET_ID=your-gcs-bucket-name

# Path prefix for private objects (receipts, claims)
PRIVATE_OBJECT_DIR=private

# Comma-separated search paths for public objects
PUBLIC_OBJECT_SEARCH_PATHS=public

# ── AI Receipt Parsing ────────────────────────────────────

# OpenAI-compatible API base URL
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1

# OpenAI API key
AI_INTEGRATIONS_OPENAI_API_KEY=sk-your-openai-api-key

# ── Web Portal ────────────────────────────────────────────

# Telegram bot username (without @) — shown on login page
VITE_TELEGRAM_BOT_USERNAME=claimbase_bot
```

### Optional Variables

```bash
# Set to "production" in production
NODE_ENV=production

# Web portal base path (default: "/")
# Only needed if serving under a subpath like /app
BASE_PATH=/
```

---

## Database Setup

### 1. Create the PostgreSQL database

```bash
createdb claimbase
# or via psql:
psql -c "CREATE DATABASE claimbase;"
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Push the schema

This uses Drizzle Kit to create all tables automatically:

```bash
cd lib/db
DATABASE_URL=postgresql://user:password@localhost:5432/claimbase pnpm run push
```

This creates these tables:
- `users` — registered users (linked to Telegram)
- `companies` — per-user companies with cut-off settings
- `categories` — system + custom expense categories
- `receipts` — uploaded receipts with AI-parsed data
- `claim_periods` — monthly claim periods with PDF/Excel URLs
- `bot_sessions` — Telegram bot conversation state
- `bulk_queues` — bulk receipt upload queues
- `resolved_flags` — flagged receipt resolution tracking

System categories (Travel, Meals & Entertainment, etc.) are auto-seeded on first API server start.

---

## Object Storage Setup

Claimbase uses Google Cloud Storage for storing receipt images and generated claim files (PDFs, Excel).

### Google Cloud Storage

1. Create a GCS bucket
2. Create a service account with `Storage Object Admin` role on the bucket
3. Download the JSON key file

For **self-hosted** (not on Replit), you need to modify the storage client initialization. The current code uses Replit's sidecar proxy. For standard GCS auth, update `artifacts/api-server/src/lib/objectStorage.ts`:

```typescript
// Replace the existing Storage initialization with:
import { Storage } from "@google-cloud/storage";

export const objectStorageClient = new Storage({
  projectId: "your-gcp-project-id",
  keyFilename: "/path/to/service-account-key.json",
  // OR use GOOGLE_APPLICATION_CREDENTIALS env var
});
```

Alternatively, set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable:
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

### S3-Compatible Alternative

If using MinIO, AWS S3, or similar, you'll need to replace `@google-cloud/storage` with the appropriate SDK and update `objectStorage.ts` accordingly.

---

## Telegram Bot Setup

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token → set as `TELEGRAM_BOT_TOKEN`
4. Send `/setcommands` and set:
   ```
   start - Register and get started
   help - Show help
   upload - Upload a receipt
   status - Check your receipts
   ```

### 2. Bot runs in polling mode

No webhook URL or SSL is needed — the bot polls Telegram's servers for updates. This works behind firewalls and NATs.

---

## AI Receipt Parsing Setup

Claimbase uses GPT-4 Vision to parse receipt images. You need an OpenAI-compatible API.

### OpenAI (recommended)

```bash
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1
AI_INTEGRATIONS_OPENAI_API_KEY=sk-your-key
```

### Azure OpenAI

```bash
AI_INTEGRATIONS_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/gpt-4o
AI_INTEGRATIONS_OPENAI_API_KEY=your-azure-key
```

### Self-hosted / Other providers

Any OpenAI-compatible API that supports vision (image input) will work. The model used is `gpt-4o-mini` — ensure your provider supports it or update the model name in `artifacts/api-server/src/lib/ai.ts`.

---

## Building the Application

### Build everything

```bash
# From project root
pnpm install
pnpm run build
```

This runs:
1. TypeScript type-checking across all packages
2. API server build (esbuild → `artifacts/api-server/dist/`)
3. Web portal build (Vite → `artifacts/web-portal/dist/public/`)

### Build components individually

```bash
# API server only
pnpm --filter @workspace/api-server run build

# Web portal only
pnpm --filter @workspace/web-portal run build
```

### Regenerate API client (after OpenAPI spec changes)

```bash
pnpm --filter @workspace/api-spec run codegen
```

---

## Running in Production

### Option A: Single Process (Recommended)

Serve both API and static frontend from the Express server. Add static file serving to `artifacts/api-server/src/app.ts`:

```typescript
import path from "path";
import express from "express";

// After API routes, serve the built web portal
const staticDir = path.resolve(__dirname, "../../web-portal/dist/public");
app.use(express.static(staticDir));

// SPA fallback — serve index.html for all non-API routes
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(staticDir, "index.html"));
  }
});
```

Then run:

```bash
cd artifacts/api-server
NODE_ENV=production node --enable-source-maps ./dist/index.mjs
```

### Option B: Separate Servers

Run the API server and serve the web portal separately:

```bash
# Terminal 1: API server
cd artifacts/api-server
NODE_ENV=production PORT=3000 node --enable-source-maps ./dist/index.mjs

# Terminal 2: Web portal (using any static server)
npx serve artifacts/web-portal/dist/public -l 8080
```

With this option, configure your reverse proxy to route `/api/*` to the API server and everything else to the static server.

### Using PM2 (recommended for production)

```bash
npm install -g pm2

# ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "claimbase-api",
    cwd: "./artifacts/api-server",
    script: "./dist/index.mjs",
    node_args: "--enable-source-maps",
    env: {
      NODE_ENV: "production",
      PORT: 3000,
    },
  }],
};

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on reboot
```

---

## Reverse Proxy (nginx)

Example nginx configuration for single-process mode:

```nginx
server {
    listen 80;
    server_name claimbase.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name claimbase.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/claimbase.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/claimbase.yourdomain.com/privkey.pem;

    client_max_body_size 50M;  # For receipt image uploads

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/web-portal/package.json artifacts/web-portal/
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm run build

# Production image
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/lib ./lib
COPY --from=base /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=base /app/artifacts/api-server/package.json ./artifacts/api-server/
COPY --from=base /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=base /app/artifacts/web-portal/dist ./artifacts/web-portal/dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
```

### docker-compose.yml

```yaml
version: "3.8"

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: claimbase
      POSTGRES_USER: claimbase
      POSTGRES_PASSWORD: changeme
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  app:
    build: .
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://claimbase:changeme@db:5432/claimbase
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      INTERNAL_API_SECRET: ${INTERNAL_API_SECRET}
      AI_INTEGRATIONS_OPENAI_BASE_URL: ${AI_INTEGRATIONS_OPENAI_BASE_URL}
      AI_INTEGRATIONS_OPENAI_API_KEY: ${AI_INTEGRATIONS_OPENAI_API_KEY}
      DEFAULT_OBJECT_STORAGE_BUCKET_ID: ${DEFAULT_OBJECT_STORAGE_BUCKET_ID}
      PRIVATE_OBJECT_DIR: private
      PUBLIC_OBJECT_SEARCH_PATHS: public
      PORT: 3000
      NODE_ENV: production

volumes:
  pgdata:
```

Run:
```bash
# Create .env with your secrets, then:
docker compose up -d

# Push database schema
docker compose exec app sh -c "cd lib/db && pnpm run push"
```

---

## Telegram Mini App Setup

To use Claimbase as a Telegram Mini App (opens inside Telegram):

1. Open [@BotFather](https://t.me/BotFather)
2. Send `/mybots` → select your bot → **Bot Settings** → **Menu Button**
3. Set the menu button URL to your deployment URL: `https://claimbase.yourdomain.com`
4. For a Mini App:
   - Go to **Bot Settings** → **Web Apps**
   - Add a Web App with the URL: `https://claimbase.yourdomain.com`

The web portal auto-detects if it's running inside Telegram and uses Telegram's auth (`initData`) instead of OTP login.

---

## Troubleshooting

### Bot not responding
- Check `TELEGRAM_BOT_TOKEN` is correct
- Ensure no other instance is polling with the same token (only one poller allowed)
- Check API server logs for "Telegram bot started (polling mode)"

### Receipt images not loading
- Verify GCS bucket permissions and credentials
- Check `DEFAULT_OBJECT_STORAGE_BUCKET_ID` matches your bucket name
- For self-hosted: ensure you updated `objectStorage.ts` auth (see Object Storage section)

### AI parsing not working
- Verify `AI_INTEGRATIONS_OPENAI_BASE_URL` and `AI_INTEGRATIONS_OPENAI_API_KEY`
- Ensure your API key has access to a vision-capable model
- Check the model name in `ai.ts` matches what your provider offers

### Database connection issues
- Verify `DATABASE_URL` format: `postgresql://user:password@host:port/dbname`
- Ensure PostgreSQL is running and accessible
- Run schema push: `cd lib/db && pnpm run push`

### Web portal shows blank page
- Ensure the built files exist in `artifacts/web-portal/dist/public/`
- Check that your reverse proxy or static server is configured for SPA (fallback to `index.html`)
- Verify `VITE_TELEGRAM_BOT_USERNAME` is set during build (Vite inlines env vars at build time)

### Currency conversion
- Exchange rates are fetched from `exchangerate-api.com` (free, no API key needed)
- Rates are cached for 1 hour
- Ensure outbound HTTPS is allowed on your server

---

## Quick Start Checklist

```
[ ] PostgreSQL database created
[ ] Dependencies installed (pnpm install)
[ ] Database schema pushed (cd lib/db && pnpm run push)
[ ] Environment variables set (see list above)
[ ] Object storage configured (GCS bucket + credentials)
[ ] Telegram bot created (@BotFather) and token saved
[ ] OpenAI API key obtained
[ ] Application built (pnpm run build)
[ ] API server started (node artifacts/api-server/dist/index.mjs)
[ ] Reverse proxy configured (nginx/Caddy) with SSL
[ ] Telegram Mini App URL set in @BotFather (optional)
```
