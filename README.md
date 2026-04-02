# Hexmon Signage Backend

Production-ready digital signage CMS backend built with Node.js, TypeScript, Fastify, PostgreSQL, MinIO, and pg-boss.

For on-prem runtime-bundle deployment, start with the canonical runbooks in the `signhex-platform` repo:

- product export packaging: `signhex-platform/docs/runbooks/product-export-packaging.md`
- QA: `signhex-platform/docs/runbooks/onprem-qa-setup.md`
- Production: `signhex-platform/docs/runbooks/onprem-production-setup.md`
See [PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md) for the current production and development support matrix.
See [MACOS_RUNTIME.md](./MACOS_RUNTIME.md) and [UBUNTU_RUNTIME.md](./UBUNTU_RUNTIME.md) for host-run setup guides.
See `signhex-platform/docs/runbooks/onprem-bundle-builder.md` for the unified QA + production runtime bundle workflow.

Supported on-prem production contract:

- CMS at `https://<cms-ip>`
- backend at `http://<backend-ip>:3000`
- player devices connect directly to backend port `3000`
- no DNS required in the supported air-gapped profile

Supported deployment workflow:

- target QA and production machines receive generated runtime folders only
- do not copy the repository to deployment targets
- generate the source-free backend deploy package from `signhex-platform/scripts/export/package-server.sh`
- the bundle builder stages backend image archives, CMS static assets, configs, scripts, and player installers

## Support Model

- macOS host-run: supported
- Linux host-run: supported
- Docker runtime: supported and optional
- Windows backend hosting: unsupported

## Features

- JWT authentication with revocation
- Role-based access control (CASL)
- PostgreSQL with Drizzle ORM
- MinIO/S3 object storage
- FFmpeg media processing
- LibreOffice-backed document conversion
- Playwright-backed webpage capture
- Background jobs with pg-boss
- Device pairing and telemetry APIs on the main backend port
- Audit logging and report export
- OpenAPI/Swagger docs

## Prerequisites

- Node.js 20 LTS
- PostgreSQL and MinIO available locally or remotely
- Host-installed runtime tools on both macOS and Linux:
  - `ffmpeg`
  - `LibreOffice/soffice`
  - Playwright Chromium
  - `pg_dump`
  - `tar`
- `.env` configured from `.env.example`

The optional Docker image also includes:

- `ffmpeg`
- `LibreOffice/soffice`
- Playwright Chromium runtime
- `pg_dump`
- `tar`

## Quick Start

```bash
git clone https://github.com/Hexmon/signhex-server
cd signhex-server
cp .env.example .env
npm install
npx playwright install chromium
docker compose up -d postgres minio
npm run db:push
npm run seed
npm run dev:watch
```

If you prefer running the API in Docker instead of directly on the host, the checked-in `docker-compose.yml` is now production-safe:

```bash
docker compose up -d postgres minio api
```

For a containerized development API with bind mounts and `npm run dev`, use the dev override:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres minio api
```

API:

- `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/docs`

## Useful Commands

```bash
npm run build
npm run lint
npm run verify
npm run doctor:runtime
npm run db:push
npm run seed
npm run reset:data -- --yes
```

## Runtime Dependency Doctor

Use the runtime doctor when you run the server outside the official container:

```bash
npm run doctor:runtime
```

It validates the required host-run toolchain:

- `ffmpeg`
- `LibreOffice`
- Playwright Chromium
- `pg_dump`
- `tar`

Startup and the runtime doctor both fail fast when any required dependency is missing.

## Docker Runtime

Build the official image:

```bash
docker build -t hexmon-signage-api .
```

Run it:

```bash
docker run --env-file .env -p 3000:3000 hexmon-signage-api
```

For the checked-in production compose stack:

```bash
docker compose up -d postgres minio api
docker compose logs -f api
```

For the checked-in containerized development stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres minio api
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f api
```

## Environment Highlights

See `.env.example` for the full list. Common variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `FFMPEG_PATH`
- `LIBREOFFICE_PATH`
- `PG_DUMP_PATH`
- `TAR_PATH`
- `HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH`
- `APP_PUBLIC_BASE_URL`
- `ENABLE_SWAGGER_UI`

All executable overrides resolve through `PATH` by default:

- `FFMPEG_PATH=ffmpeg`
- `LIBREOFFICE_PATH=soffice`
- `PG_DUMP_PATH=pg_dump`
- `TAR_PATH=tar`

Set `HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH` only when Chromium is installed outside the standard Playwright location.

## Project Layout

```text
src/
  auth/           Authentication and JWT handling
  config/         Environment config
  db/             Schema and repositories
  jobs/           Background job handlers
  routes/         Fastify route handlers
  s3/             MinIO/S3 integration
  utils/          Shared utilities

drizzle/
  migrations/     Database migrations

scripts/
  seed.ts
  runtime-doctor.ts
```

## Deployment Notes

- Host-run server deployments on macOS and Linux are supported when the required tools are installed locally.
- Docker remains available for packaging and operational convenience, but it is not the only feature-complete runtime.
- `docker-compose.yml` is production-safe and runs the built server with `npm start`.
- `docker-compose.dev.yml` is the opt-in development override that restores bind mounts and `npm run dev`.
- Windows backend production hosting remains out of scope.

## License

MIT
