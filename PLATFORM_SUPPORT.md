# Hexmon Signage Backend Platform Support

## Support Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| Linux host | Supported | Feature-complete host-run backend with Node 20 LTS plus `ffmpeg`, `LibreOffice`, Playwright Chromium, `pg_dump`, and `tar`. Ubuntu is the reference distro. |
| macOS host | Supported | Feature-complete host-run backend with the same toolchain as Linux. |
| Docker runtime | Supported | Optional packaging and convenience runtime. Same backend features, same APIs. |
| Windows host | Unsupported | Backend production and host-run support are out of scope. Use Linux or macOS. |

## Host-Run Contract

Both macOS and Linux host-run servers require:

- `ffmpeg`
- `LibreOffice/soffice`
- Playwright Chromium runtime
- `pg_dump`
- `tar`

Install them on the host or point the server at explicit executables with:

- `FFMPEG_PATH`
- `LIBREOFFICE_PATH`
- `PG_DUMP_PATH`
- `TAR_PATH`
- `HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH`

## Runtime Validation

The backend validates these dependencies at startup and through:

- `npm run doctor:runtime`

Missing dependencies are treated as startup errors on both macOS and Linux so media processing, webpage capture, and backups fail early instead of at job execution time.

## Media Processing Notes

- Document conversion uses LibreOffice on both macOS and Linux.
- Webpage capture uses Playwright Chromium on both macOS and Linux.
- FFmpeg processing resolves through `FFMPEG_PATH` or the host `PATH`.

## Backup Notes

- Object storage backup remains in-process
- PostgreSQL backup uses `pg_dump` from `PG_DUMP_PATH` or the host `PATH`
- Docker fallback for `pg_dump` may still be used when available, but host-installed `pg_dump` is the primary supported path
- For host-run setup and verification, use [MACOS_RUNTIME.md](./MACOS_RUNTIME.md) and [UBUNTU_RUNTIME.md](./UBUNTU_RUNTIME.md).
