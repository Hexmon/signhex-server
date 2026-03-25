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
git clone https://github.com/Hexmon/signhex-server
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

The API will be available at `http://localhost:3000/api/v1`
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

- `POST /api/v1/auth/login` - Login with email/password
- `POST /api/v1/auth/logout` - Logout and revoke token
- `GET /api/v1/auth/me` - Get current user

### Users

- `POST /api/v1/users` - Create user (admin only)
- `GET /api/v1/users` - List users
- `GET /api/v1/users/:id` - Get user by ID
- `PATCH /api/v1/users/:id` - Update user (admin only)
- `DELETE /api/v1/users/:id` - Delete user (admin only)

### Media

- `POST /api/v1/media/presign-upload` - Get presigned upload URL
- `POST /api/v1/media` - Create media metadata
- `GET /api/v1/media` - List media
- `GET /api/v1/media/:id` - Get media by ID

## Environment Variables

See `.env.example` for all available options:

- `NODE_ENV` - Environment (development/production/test)
- `HOST` - Bind host for API server (default: 0.0.0.0)
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

---

## Device Pairing 500 (CA_CERT_MISSING) — Meaning + Fix (mTLS, CSR, CA)

If you see a 500 during device pairing completion and logs mention `ENOENT` → `CA_CERT_MISSING`, it means the backend tried to read the CA certificate from `CA_CERT_PATH` but the file was missing.

### Quick meaning of the terms (the “why”)

**TLS**  
Normal HTTPS encryption between client and server.  
Server proves its identity using `server.crt` + `server.key`.

**mTLS (mutual TLS)**  
TLS, but both sides prove identity:
- Server proves identity with `server.crt`/`server.key`
- Client (your desktop app/device) proves identity with a client certificate
- Both sides trust the same CA certificate (`ca.crt`) that issued those certs

**Purpose:** strong device identity + prevents unauthorized devices from talking to the device/server port.

**CA Certificate (`ca.crt`)**  
The “root” certificate that signs other certs.  
Server uses it to verify client certs, and the pairing route uses it to sign the device certificate from the CSR (and typically also needs the CA private key).

**CSR (Certificate Signing Request)**  
A CSR is generated by the client/device. It contains:
- the public key
- identity info (CN/SAN like `deviceId`)
- and is signed by the device’s private key (proof it owns the key)

Backend signs it using the CA and produces the final device/client certificate.

---

## What you should do next (server-side)

### 1) Check what path the server expects

Look at your `.env` / environment:

- `CA_CERT_PATH` (maybe set, maybe defaulting to `ca.crt`)

Rule: the file must exist at that exact path from where the server is running.

✅ Fix options:
- Put the CA cert file at `./ca.crt` in the backend project root (if that’s the default), OR
- Set `CA_CERT_PATH` to an absolute path (recommended), e.g.
  - macOS/Linux: `/opt/myapp/secrets/ca.crt`
  - Windows: `C:\myapp\secrets\ca.crt`

Then restart the server.

### 2) Make sure you also have the CA key (very likely required)

Even though the summary mentions reading the CA cert, device pairing usually needs the CA private key to sign the device CSR.

So check if you also have env vars like:
- `CA_KEY_PATH`, `CA_PRIVATE_KEY_PATH`, `TLS_CA_KEY_PATH`, etc.

If the key is missing, you’ll hit the next failure immediately after fixing `ca.crt`.

### 3) If you don’t have a CA yet (dev setup)

Ask the backend to add the promised “bootstrap script”, or you generate a dev CA yourself (only for dev/test).  
If you want, tell me what your backend expects for the key env var name and file format (PEM), and I’ll give you the exact minimal setup.

---

## What you should do next (client/desktop app)

Your desktop app does not need OS-specific changes just to fix this 500.

But after the server has a CA cert/key correctly configured, these are the client-side things to verify:

### A) The CSR is correct format

They added warnings for “CSR base64” issues.  
So ensure your app sends CSR in the exact expected encoding (commonly: base64 of PEM, or raw PEM).

### B) `deviceId` must match (new 409)

They added a check: CSR `deviceId` mismatch → HTTP 409.  
So if you start seeing 409 after fixing CA cert, it means:
- your payload says `deviceId = X`
- the CSR (or CSR metadata) implies `deviceId = Y`

You’d then align how the desktop app generates device identity.

---

## Cross-platform reality check (Windows / macOS / Ubuntu)

This pairing flow is typically designed like this:
- Desktop app generates a private key + CSR locally
- Backend signs it using the CA key
- Desktop app stores the issued device cert + private key (per OS storage)

Windows: DPAPI / cert store (depends on your app)  
macOS: Keychain  
Linux: file storage with permissions or secret service

You only need to install CA into OS trust store if your app/OS needs to trust certificates signed by that CA for general TLS validation (depends on your architecture). Most apps can pin the CA internally and avoid OS installs.

---

## Quick “do this now” checklist

- On backend machine/container: confirm `CA_CERT_PATH` and ensure the file exists there.
- Ensure CA key path is also configured (if required).
- Restart backend.
- Retry pairing from desktop app.
- If you now get 409 → fix `deviceId`/CSR mismatch.
- Run `npm run test` when ready to regenerate `api-test-report.md`.

---

## Your current `.env` note (missing `./certs` folder)

Your `.env` says:

- `TLS_CERT_PATH=./certs/server.crt`
- `TLS_KEY_PATH=./certs/server.key`
- `CA_CERT_PATH=./certs/ca.crt`

…but the `./certs` folder does not exist. That’s why Node throws `ENOENT` (file not found) → `CA_CERT_MISSING` → 500.

Create the folder and provide the files, or update the env paths to real existing files.

---

## About `IP.1 = 127.0.0.1` vs Wi-Fi IP `192.168.0.3` (certificate SAN)

`IP.1 = 127.0.0.1` is there so the server certificate is valid when you access the backend from the same machine using:

- `https://127.0.0.1:8443` (or `https://localhost:8443`)

That’s the loopback address (“this computer”). It only works on the same device where the server is running.

### Why it matters

TLS certs must match the hostname/IP you connect to. The `subjectAltName` (SAN) section is what modern clients validate.

So:
- If your desktop app connects to `https://192.168.0.3:8443`, then the server cert must include `192.168.0.3` in SAN.
- Having only `127.0.0.1` and `localhost` won’t match `192.168.0.3` → certificate mismatch errors.

### What to do for your Wi-Fi IP (`192.168.0.3`)

Add it to the SAN list and re-issue the server cert:

Update `certs/server.ext` like this:

```ini
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = 192.168.0.3
Then re-sign the server certificate:

openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial \
  -out certs/server.crt -days 825 -sha256 -extfile certs/server.ext


Restart the server after.

Practical note

If your IP changes (Wi-Fi DHCP), the cert can break again. For dev, common options are:

Use localhost only (best when app runs on same machine)

Use a stable hostname (e.g., my-devbox.local) and put that in DNS.1, then connect via that hostname

Or regenerate cert when IP changes

Now apply this change and return the full README.md content.

END.
