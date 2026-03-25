# AGENTS.md

## Purpose
This repo is the backend for Signhex. Future agents must treat route, repository, schema, realtime, test, and docs alignment as one feature surface.

## Required workflow
1. Trace the feature end-to-end before editing.
2. Inspect the real entrypoint first:
   - route
   - service/repository
   - schema/migration
   - realtime emitter/consumer if applicable
   - existing tests
   - docs/runbooks
3. Edit the smallest correct set of files.
4. If behavior or contract changes, update tests and docs in the same change.
5. Do not declare a feature complete until required local validation passes.

## Backend-specific tracing rules
- For HTTP/API work: trace route -> repository/service -> schema -> docs.
- For lifecycle/realtime work: also trace websocket namespace, dry-run scripts, and emitted event payloads.
- For DB-sensitive work: inspect migrations and repository query behavior before patching routes.
- For recovery/auth work: inspect request auth, JWT/session logic, and device auth middleware before changing behavior.

## Testing policy
Every feature change must include one or more of:
- focused Vitest route/repository test
- realtime namespace test
- dry-run script coverage if lifecycle/realtime behavior is affected
- docs update if API or operator behavior changes

Utility-only tests are not enough when public behavior changes.

## Minimum validation before completion
- `npm run build`
- focused Vitest suites for the touched area
- `npm run screens:dry-run` if screen/device lifecycle or realtime behavior changed
- `npm run jobs:repair-pgboss-queues` only when job bootstrap/pg-boss state is part of the task

## File change guidance
- Prefer route-local tests beside the route area already used in this repo.
- Prefer additive docs in `docs/` over hidden knowledge in comments.
- Keep machine-readable error codes stable when possible.
- Never widen scope to unrelated modules just to silence unrelated failures.
