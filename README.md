# Hexmon Signage Backend

Production-ready digital signage CMS backend built with Node.js, TypeScript, Fastify, PostgreSQL, MinIO, and pg-boss.

See [PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md) for the current production and development support matrix.

## Support Model

- Ubuntu production: supported through the official container runtime
- Windows and macOS development: supported through Docker-based local environments
- Container-first runtime for media processing, webpage capture, and backups

## Features

- JWT authentication with revocation
- Role-based access control (CASL)
- PostgreSQL with Drizzle ORM
- MinIO/S3 object storage
- FFmpeg media processing
- LibreOffice-backed document conversion
- Playwright-backed webpage capture
- Background jobs with pg-boss
- Device mTLS on a dedicated port
- Audit logging and report export
- OpenAPI/Swagger docs

## Prerequisites

- Node.js 18+
- Docker and Docker Compose for the supported local runtime
- `.env` configured from `.env.example`

The official production image includes:

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
docker compose up -d postgres minio
npm run db:push
npm run seed
npm run dev:watch
```

For the dependency-complete local runtime, prefer running the API through Docker Compose too:

```bash
docker compose up -d postgres minio api
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

It reports the availability of:

- `ffmpeg`
- `LibreOffice`
- Playwright Chromium
- `pg_dump`
- `tar`

Outside the container runtime, missing dependencies are reported clearly so you can fall back to Docker instead of discovering failures during media jobs or backups.

## Docker Runtime

Build the official image:

```bash
docker build -t hexmon-signage-api .
```

Run it:

```bash
docker run --env-file .env -p 3000:3000 -p 8443:8443 hexmon-signage-api
```

## Environment Highlights

See `.env.example` for the full list. Common variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `FFMPEG_PATH`
- `APP_PUBLIC_BASE_URL`

`FFMPEG_PATH` now defaults to `ffmpeg` and resolves through `PATH`. The official container sets the toolchain up for you.

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

- The official production path is the container image on Ubuntu hosts.
- Host-installed production dependencies are not the supported contract anymore.
- Windows backend production hosting remains out of scope.

## License

MIT
