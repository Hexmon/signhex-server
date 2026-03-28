# Ubuntu Host-Run Setup

This guide covers the supported Linux host-run backend path. Ubuntu LTS is the reference environment.

## 1. Install Node 20 LTS

Use your preferred Node version manager or distro package source, then confirm:

```bash
node -v
npm -v
```

Expected result:

- Node 20.x
- npm available

## 2. Install Required Host Tools

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg libreoffice postgresql-client tar
```

Install the Playwright Chromium runtime from the project root after `npm install`:

```bash
npx playwright install chromium --with-deps
```

## 3. Configure The Project

```bash
cp .env.example .env
npm install
```

The default runtime tool settings already work for a normal Ubuntu host:

- `FFMPEG_PATH=ffmpeg`
- `LIBREOFFICE_PATH=soffice`
- `PG_DUMP_PATH=pg_dump`
- `TAR_PATH=tar`

Only set `HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH` if Chromium lives outside the Playwright-managed location.

## 4. Start PostgreSQL And MinIO

For local verification, Docker is still convenient for data services:

```bash
docker compose up -d postgres minio
```

Then initialize the database:

```bash
npm run db:push
npm run seed
```

## 5. Verify The Host Toolchain

```bash
npm run doctor:runtime
```

Expected result:

- all five dependencies are reported as `available`
- the command exits with code `0`

## 6. Run The Server Directly On Ubuntu

```bash
npm run dev:watch
```

Or for a production-style local run:

```bash
npm run build
npm start
```

Then verify:

```bash
curl -sS http://localhost:3000/health
```

## 7. Functional Checks

Verify these existing features against the host-run server:

- video transcode job completes through FFmpeg
- `csv/xls/xlsx/doc/docx/ppt/pptx` conversion completes through LibreOffice
- webpage capture completes through Playwright Chromium
- manual backup completes with PostgreSQL and object-storage archives
- existing API responses remain unchanged

## 8. Optional Docker Runtime

Docker remains supported, but it is optional:

```bash
docker compose up -d postgres minio api
```

Use this when you want packaging convenience, not because host-run Linux is incomplete.

## 9. Regression Checklist

Re-run this checklist after dependency or packaging changes:

1. `npm install`
2. `npx playwright install chromium --with-deps`
3. `npm run doctor:runtime`
4. `docker compose up -d postgres minio`
5. `npm run db:push`
6. `npm run seed`
7. `npm run build`
8. `npm start`
9. media processing, webpage capture, and backup smoke tests
