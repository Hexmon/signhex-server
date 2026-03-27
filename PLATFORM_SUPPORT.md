# Hexmon Signage Backend Platform Support

## Support Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| Ubuntu container runtime | Production | Official production target. Use the provided container image for media processing, webpage capture, and backups. |
| Windows host | Development only | Supported for local development and validation through Docker. Not an official production host target. |
| macOS host | Development only | Supported for local development and validation through Docker. Not an official production host target. |

## Official Runtime

The supported production backend runtime is the container image. It includes:

- `ffmpeg`
- `LibreOffice/soffice`
- Playwright Chromium runtime
- `pg_dump`
- `tar`

## Host-Run Behavior

The backend performs dependency checks at startup and through:

- `npm run doctor:runtime`

Outside the official container runtime, missing processing tools are reported clearly so Windows and macOS development environments can fall back to Docker instead of failing silently.

## Media Processing Notes

- Official document conversion backend: LibreOffice in the container runtime
- macOS QuickLook fallback remains available only as a host-run development convenience
- Webpage capture uses Playwright Chromium and is treated as a containerized runtime dependency

## Backup Notes

- Object storage backup remains in-process
- PostgreSQL backup relies on `pg_dump`, which is guaranteed in the container image
- Host-run backups may still fall back to Docker for PostgreSQL when available
