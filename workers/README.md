# ntfy Cloudflare Workers

This directory contains the Cloudflare Workers implementation of ntfy, allowing you to run ntfy on Cloudflare Pages with Workers for the API backend.

## Architecture

- **Cloudflare Pages**: Serves the React UI (static assets)
- **Workers (Pages Functions)**: Handles API requests
- **D1**: SQLite-compatible database for messages and users
- **Durable Objects**: Per-topic WebSocket pub/sub

## Prerequisites

1. Cloudflare account with Workers Paid plan (required for Durable Objects)
2. Node.js 18+
3. Wrangler CLI (`npm install -g wrangler`)

## Setup

### 1. Install Dependencies

```bash
cd workers
npm install
```

### 2. Create D1 Database

```bash
# Create the database
wrangler d1 create ntfy

# Note the database_id from the output and update wrangler.toml
```

### 3. Update wrangler.toml

Replace `placeholder-update-after-creation` with your actual D1 database ID.

### 4. Apply Database Schema

```bash
# Local development
npm run db:migrate

# Production
npm run db:migrate:remote
```

### 5. Set Secrets

```bash
wrangler secret put JWT_SECRET
# Enter a secure random string when prompted
```

## Development

```bash
# Start local development server
npm run dev
```

The worker will be available at `http://localhost:8787`.

## Deployment

### Deploy Worker Only

```bash
npm run deploy
```

### Deploy with UI (Full Pages Deployment)

1. Build the web UI:
```bash
cd ../web
npm install
npm run build
```

2. Copy build output to workers public directory:
```bash
cp -r build/* ../workers/public/
```

3. Deploy to Pages:
```bash
cd ../workers
wrangler pages deploy public --project-name ntfy
```

Or connect your repository to Cloudflare Pages for automatic deployments.

## API Compatibility

This implementation aims for compatibility with the original ntfy API:

### Publishing
- `POST/PUT /{topic}` - Publish message
- Headers: `X-Title`, `X-Priority`, `X-Tags`, `X-Click`, `X-Icon`, `X-Actions`, `X-Markdown`

### Subscribing
- `GET /{topic}/ws` - WebSocket subscription
- `GET /{topic}/sse` - Server-Sent Events
- `GET /{topic}/json` - JSON polling
- `GET /{topic}.json` - JSON (alternative)
- `GET /{topic}.sse` - SSE (alternative)

### Account
- `POST /v1/account` - Create account
- `GET /v1/account` - Get account info
- `POST /v1/account/token` - Create token
- `DELETE /v1/account/token/:token` - Delete token
- `POST /v1/account/password` - Change password
- `DELETE /v1/account` - Delete account

### Other
- `GET /v1/health` - Health check
- `GET /v1/stats` - Message statistics
- `GET /config.js` - UI configuration
- `POST /auth` - Authentication check

## Limitations

Features not yet implemented:
- Attachments (requires R2)
- Web Push notifications
- Firebase Cloud Messaging
- Email/SMS notifications
- SMTP server (not possible in Workers)

## Project Structure

```
workers/
├── src/
│   ├── index.ts              # Main entry point
│   ├── router.ts             # Routing utilities
│   ├── types/
│   │   ├── env.ts            # Environment bindings
│   │   ├── message.ts        # Message types
│   │   └── user.ts           # User/auth types
│   ├── database/
│   │   ├── schema.sql        # D1 schema
│   │   ├── messages.ts       # Message queries
│   │   └── users.ts          # User queries
│   ├── handlers/
│   │   ├── publish.ts        # Publish handler
│   │   ├── subscribe.ts      # Subscribe handlers
│   │   └── account.ts        # Account handlers
│   ├── auth/
│   │   ├── jwt.ts            # JWT utilities
│   │   ├── password.ts       # Password hashing
│   │   ├── middleware.ts     # Auth middleware
│   │   └── access.ts         # Access control
│   └── durable-objects/
│       └── TopicDO.ts        # Per-topic WebSocket DO
├── public/
│   └── _routes.json          # Pages routing config
├── wrangler.toml             # Wrangler configuration
├── package.json
└── tsconfig.json
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JWT_SECRET` | Secret for signing JWT tokens | Yes (secret) |
| `DEFAULT_MESSAGE_EXPIRY` | Message expiry in seconds (default: 43200) | No |
| `MAX_MESSAGE_SIZE` | Max message size in bytes (default: 4096) | No |
| `KEEPALIVE_INTERVAL` | WebSocket keepalive in seconds (default: 45) | No |
