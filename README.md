# Hexmon Signage - Production-Ready Backend

A comprehensive, production-ready digital signage CMS backend built with Node.js, TypeScript, Fastify, PostgreSQL, and MinIO.

## Features

- **JWT Authentication** with JTI-based revocation (no refresh tokens)
- **Role-Based Access Control (RBAC)** with CASL
- **PostgreSQL** with Drizzle ORM
- **MinIO** for immutable object storage
- **FFmpeg** integration for media processing
- **WebSocket** support for real-time updates
- **mTLS** device authentication on separate port
- **Comprehensive Audit Logging** with MinIO storage
- **Background Jobs** with pg-boss
- **OpenAPI/Swagger** documentation
- **Docker Compose** for local development

## Prerequisites

- Node.js 18+
- Docker & Docker Compose (for local development)
- PostgreSQL 14+ (or use Docker)
- MinIO (or use Docker)
- FFmpeg (for media processing)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository>
cd server
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Database Setup

```bash
# Run migrations
npm run migrate

# Seed initial data
npm run seed
```

### 4. Start Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`
Swagger UI: `http://localhost:3000/docs`

## Docker Compose

For a complete local development environment:

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- MinIO on ports 9000 (API) and 9001 (Console)
- API on ports 3000 (HTTP) and 8443 (mTLS)

## Project Structure

```
src/
  config/          # Configuration management
  auth/            # JWT, password hashing
  rbac/            # Role-based access control
  db/              # Database schema and repositories
  s3/              # MinIO/S3 integration
  server/          # Fastify server setup
  routes/          # API route handlers
  schemas/         # Zod validation schemas
  utils/           # Utility functions
  index.ts         # Application entry point

drizzle/
  migrations/      # Database migrations

scripts/
  seed.ts          # Database seeding
  admin-cli.ts     # Admin CLI utilities
```

## API Endpoints

### Authentication

- `POST /v1/auth/login` - Login with email/password
- `POST /v1/auth/logout` - Logout and revoke token
- `GET /v1/auth/me` - Get current user

### Users

- `POST /v1/users` - Create user (admin only)
- `GET /v1/users` - List users
- `GET /v1/users/:id` - Get user by ID
- `PATCH /v1/users/:id` - Update user (admin only)
- `DELETE /v1/users/:id` - Delete user (admin only)

### Media

- `POST /v1/media/presign-upload` - Get presigned upload URL
- `POST /v1/media` - Create media metadata
- `GET /v1/media` - List media
- `GET /v1/media/:id` - Get media by ID

## Environment Variables

See `.env.example` for all available options:

- `NODE_ENV` - Environment (development/production/test)
- `PORT` - API server port (default: 3000)
- `DEVICE_PORT` - mTLS device server port (default: 8443)
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `JWT_EXPIRY` - Token expiry in seconds (default: 900)
- `MINIO_*` - MinIO configuration
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` - Initial admin user

## Development

### Build

```bash
npm run build
```

### Lint

```bash
npm run lint
npm run format
```

### Test

```bash
npm test
npm run test:coverage
```

### Database Migrations

```bash
# Generate migration from schema changes
npm run migrate:generate

# Run pending migrations
npm run migrate
```

## Security

- **Transport**: TLS 1.2+ for all connections
- **Device API**: Separate mTLS server with client certificate verification
- **JWT**: Short-lived tokens (≤15m) with JTI revocation
- **Passwords**: Argon2id hashing
- **RBAC**: Enforced at handler and repository levels
- **Validation**: Zod schemas on all inputs
- **Headers**: Helmet for security headers
- **Rate Limiting**: Per-IP and per-user limits
- **Audit**: All mutations logged with user, action, IP, and timestamp

## Deployment

### Docker

```bash
docker build -t hexmon-api .
docker run -p 3000:3000 -p 8443:8443 --env-file .env hexmon-api
```

### systemd

A systemd unit file is provided for production deployments:

```bash
sudo cp signhex-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable signhex-api
sudo systemctl start signhex-api
```

## Monitoring

- **Logs**: Structured JSON logging with Pino
- **Metrics**: Prometheus metrics via `prom-client`
- **Health**: `GET /health` endpoint

## License

MIT

## Support

For issues and questions, please refer to the project documentation or contact the development team.



Got it. Here’s a **short, clear picture** for an **on-prem** signage setup (CMS + backend + DB in your secure area; Ubuntu thin clients over LAN running your Electron app). You only need a few free/open-source pieces:

# What to install (who + what)

**On the central server (secure area):**

1. **Prometheus** – collects health data from all thin clients and checks if your app is alive.
2. **Grafana** – shows everything on dashboards + sends alerts (email/Slack, etc.).
3. **MeshCentral** – remote desktop/terminal/file copy to any thin client for fast fixes.

**On every thin client (Ubuntu):**

1. **node_exporter** – tiny agent that exposes CPU, RAM, disk, temperature, network.
2. **Your Electron/Node app health endpoint** – a simple `/healthz` HTTP route that says “I’m OK” and (optionally) reports app version, current playlist, last content fetch time.
3. *(Optional now / later)* **Display metrics script** – reads monitor info (connected? resolution? model?) and drops it as metrics so Prometheus can see screen health.

That’s it. Three things on the server; one tiny agent + your app endpoint on the clients. Fully on-prem, no internet required.

---

# How they work together (in plain words)

* **node_exporter** → “PC health” (CPU, RAM, disk, etc.).
* **Your `/healthz` route** → “App health” (is the player running/responding?).
* **Prometheus** → “Collector + Alert brain” (pulls metrics from each client and pings `/healthz`).
* **Grafana** → “Control room screen” (nice charts + alerts history).
* **MeshCentral** → “Wrench in your hand” (remote in, restart app, check logs, copy files).

---

# Minimal wiring (copy these ideas)

### 1) Electron/Node: add a tiny health route

```js
// health.js
import express from "express";
const app = express();

app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    app: "hexmon-signage",
    version: "1.0.0",
    time: Date.now()
  });
});

app.listen(3300); // run alongside your player
```

### 2) Prometheus (server) – tell it what to scrape

```yaml
# prometheus.yml (very small sample)
scrape_configs:
  - job_name: "thinclient-system"
    static_configs:
      - targets: ["10.0.0.21:9100", "10.0.0.22:9100"]  # node_exporter on clients

  - job_name: "player-app-health"
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
        - http://10.0.0.21:3300/healthz
        - http://10.0.0.22:3300/healthz
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - target_label: __address__
        replacement: 127.0.0.1:9115   # blackbox_exporter address
```

> This uses **blackbox_exporter** (runs on the server) to check each client’s `/healthz` URL returns 200 OK.

### 3) Grafana

* Add Prometheus as a data source.
* Import a “Node exporter / host overview” dashboard (CPU/RAM/disk) and a simple uptime panel for `/healthz`.
* Add alerts (e.g., “if client down > 5 min” or “disk > 90%”).

### 4) MeshCentral

* Install on the server, install agent on each client.
* When a client misbehaves, open remote desktop/terminal and fix (restart app, pull logs).

---

# Screen / monitor health (short & useful)

If you also want “is a screen connected?” and “what resolution?”:

* On the thin client, run a small script every minute:

  * `xrandr --query` → connected + resolution
  * read EDID from `/sys/class/drm/*/edid` → monitor model/serial
  * write results into a text file for node_exporter’s **textfile collector** (e.g., `/var/lib/node_exporter/textfile_collector/display.prom`)
* Prometheus reads those values; Grafana shows “Screen connected = 1/0”, “Resolution = 1920×1080”, etc.
  *(You can add brightness/power later with `ddcutil` if your screens support DDC/CI.)*

---

# What you’ll see, simply

* **Device health**: CPU, RAM, disk, temps, network.
* **App health**: “Player alive?” (HTTP 200), quick error rate if you expose it.
* **Screen health**: connected? resolution? (optional script).
* **Instant action**: remote in via MeshCentral to troubleshoot.

---

# Why this is a good starting point

* **Simple** (few moving parts).
* **On-prem** (works fully offline on LAN).
* **Free & open-source**.
* **Extensible** (later add logs with Loki/Promtail, or MQTT heartbeats, etc.).

If you want, say the word and I’ll give you a **one-machine pilot bundle** (docker-compose for Prometheus + Grafana + blackbox, plus the node_exporter install steps and a tiny “screen metrics” script) so you can see it working with one player before rolling out to all.
