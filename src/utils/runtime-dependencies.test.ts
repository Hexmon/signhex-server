import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('runtime dependency resolution', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('finds bare executables through PATH for runtime doctor checks', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'signhex-runtime-bin-'));
    const executableName = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
    const executablePath = join(binDir, executableName);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(executablePath, process.platform === 'win32' ? '@echo off\r\necho pg_dump\r\n' : '#!/bin/sh\necho pg_dump\n', {
      mode: 0o755,
    });

    process.env.PATH = binDir;

    const { inspectRuntimeDependencies } = await import('@/utils/runtime-dependencies');
    const report = await inspectRuntimeDependencies();
    const pgDump = report.dependencies.find((dependency) => dependency.name === 'pg_dump');

    expect(pgDump?.status).toBe('available');
    expect(pgDump?.path).toContain(executableName);
  });
});
