import { describe, expect, it } from 'vitest';
import { shouldPersistTelemetryInline } from '@/routes/device-telemetry';

describe('device telemetry runtime mode', () => {
  it('uses inline persistence in development api-only mode', () => {
    expect(shouldPersistTelemetryInline('development', 'api')).toBe(true);
  });

  it('does not use inline persistence outside development api-only mode', () => {
    expect(shouldPersistTelemetryInline('production', 'api')).toBe(false);
    expect(shouldPersistTelemetryInline('development', 'worker')).toBe(false);
    expect(shouldPersistTelemetryInline('development', 'all')).toBe(false);
    expect(shouldPersistTelemetryInline('test', 'api')).toBe(false);
    expect(shouldPersistTelemetryInline('development', undefined)).toBe(false);
  });
});
