# Screen Lifecycle Test Matrix

| Scenario | Current test files | Test level | Gap status |
| --- | --- | --- | --- |
| First-time pairing | `src/routes/device-pairing.test.ts`, `src/routes/device-pairing-recovery.test.ts` | integration | Covered |
| Already-paired boot contract | `src/routes/device-telemetry-auth.test.ts`, `scripts/screens-realtime-dry-run.ts` | integration, dry-run | Covered |
| Same-device recovery | `src/routes/device-pairing.test.ts`, `src/routes/device-pairing-recovery.test.ts` | integration | Covered |
| Stale heartbeat health | `src/routes/screens.test.ts` | integration | Partial |
| Deleted screen | `src/routes/device-telemetry-auth.test.ts`, `src/routes/screens.test.ts` | integration | Covered |
| Expired/revoked credentials | `src/routes/device-telemetry-auth.test.ts`, `src/routes/device-pairing-recovery.test.ts` | integration | Covered |
| Transient network failure | `scripts/screens-realtime-dry-run.ts` | dry-run | Partial |
| Unsupported codec targeting | `src/routes/schedules.publish.test.ts` | integration | Covered |
| Realtime dashboard update | `src/realtime/screens-namespace.test.ts`, `scripts/screens-realtime-dry-run.ts` | integration, dry-run | Covered |
| Proof-of-play backlog replay | N/A in backend scope | N/A | Out of scope |
| Screenshot failure | N/A in backend scope | N/A | Out of scope |
| Command dedupe | N/A in backend scope | N/A | Out of scope |
| Invalid CSR | `src/routes/device-pairing.test.ts` | integration | Covered |
| Expired pairing code | `src/routes/device-pairing.test.ts` | integration | Covered |
| CSR device-id mismatch | `src/routes/device-pairing.test.ts` | integration | Covered |
| Recovery diagnostics endpoint | `src/routes/device-pairing.test.ts`, `src/routes/device-pairing-recovery.test.ts` | integration | Covered |
| Canonical health state derivation | `src/routes/screens.test.ts` | integration | Covered |

## Standard validation commands
- `npm run build`
- `npm run jobs:repair-pgboss-queues`
- `npx vitest run src/routes/device-pairing.test.ts src/routes/device-pairing-recovery.test.ts src/routes/device-telemetry-auth.test.ts src/routes/screens.test.ts src/routes/schedules.publish.test.ts src/realtime/screens-namespace.test.ts`
- `npm run screens:dry-run`
