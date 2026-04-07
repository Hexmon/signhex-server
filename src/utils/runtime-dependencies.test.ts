import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('runtime dependency resolution', () => {
  const originalEnv = { ...process.env };

  function applyMinimumEnv() {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/signhex';
    process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678901234567890123456789012';
    process.env.MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    process.env.MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
    process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  }

  function createExecutable(binDir: string, name: string) {
    const executableName = process.platform === 'win32' ? `${name}.exe` : name;
    const executablePath = join(binDir, executableName);
    writeFileSync(executablePath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', {
      mode: 0o755,
    });
    return executablePath;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unmock('playwright');
  });

  it('finds bare executables through PATH for runtime doctor checks', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'signhex-runtime-bin-'));
    mkdirSync(binDir, { recursive: true });
    const executablePath = createExecutable(binDir, 'pg_dump');
    const chromiumPath = createExecutable(binDir, 'chromium');

    vi.doMock('playwright', () => ({
      chromium: {
        executablePath: () => chromiumPath,
      },
    }));

    process.env.PATH = binDir;
    applyMinimumEnv();

    const { inspectRuntimeDependencies } = await import('@/utils/runtime-dependencies');
    const report = await inspectRuntimeDependencies();
    const pgDump = report.dependencies.find((dependency) => dependency.name === 'pg_dump');

    expect(pgDump?.status).toBe('available');
    expect(pgDump?.path).toContain(process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  });

  it('honors explicit executable overrides for host-run parity', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'signhex-runtime-override-'));
    mkdirSync(binDir, { recursive: true });

    const ffmpegPath = createExecutable(binDir, 'custom-ffmpeg');
    const sofficePath = createExecutable(binDir, 'custom-soffice');
    const pgDumpPath = createExecutable(binDir, 'custom-pg-dump');
    const tarPath = createExecutable(binDir, 'custom-tar');
    const chromiumPath = createExecutable(binDir, 'custom-chromium');

    process.env.FFMPEG_PATH = ffmpegPath;
    process.env.LIBREOFFICE_PATH = sofficePath;
    process.env.PG_DUMP_PATH = pgDumpPath;
    process.env.TAR_PATH = tarPath;
    process.env.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH = chromiumPath;
    process.env.PATH = '';
    applyMinimumEnv();

    const { inspectRuntimeDependencies } = await import('@/utils/runtime-dependencies');
    const report = await inspectRuntimeDependencies();

    expect(report.dependencies.every((dependency) => dependency.status === 'available')).toBe(true);
    expect(report.dependencies.find((dependency) => dependency.name === 'ffmpeg')?.path).toBe(ffmpegPath);
    expect(report.dependencies.find((dependency) => dependency.name === 'libreoffice')?.path).toBe(sofficePath);
    expect(report.dependencies.find((dependency) => dependency.name === 'pg_dump')?.path).toBe(pgDumpPath);
    expect(report.dependencies.find((dependency) => dependency.name === 'tar')?.path).toBe(tarPath);
    expect(report.dependencies.find((dependency) => dependency.name === 'chromium')?.path).toBe(chromiumPath);
  });

  it('fails fast when required host-run dependencies are missing', async () => {
    vi.doMock('playwright', () => ({
      chromium: {
        executablePath: () => join(tmpdir(), 'missing-playwright-chromium'),
      },
    }));

    process.env.FFMPEG_PATH = join(tmpdir(), 'missing-ffmpeg');
    process.env.LIBREOFFICE_PATH = join(tmpdir(), 'missing-soffice');
    process.env.PG_DUMP_PATH = join(tmpdir(), 'missing-pg-dump');
    process.env.TAR_PATH = join(tmpdir(), 'missing-tar');
    process.env.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH = join(tmpdir(), 'missing-chromium');
    process.env.PATH = '';
    applyMinimumEnv();

    const { validateRuntimeDependencies } = await import('@/utils/runtime-dependencies');

    await expect(validateRuntimeDependencies()).rejects.toThrow('Missing required runtime dependencies');
  });

  it('allows api-only runtime when worker dependencies are absent', async () => {
    vi.doMock('playwright', () => ({
      chromium: {
        executablePath: () => join(tmpdir(), 'missing-playwright-chromium'),
      },
    }));

    process.env.FFMPEG_PATH = join(tmpdir(), 'missing-ffmpeg');
    process.env.LIBREOFFICE_PATH = join(tmpdir(), 'missing-soffice');
    process.env.PG_DUMP_PATH = join(tmpdir(), 'missing-pg-dump');
    process.env.TAR_PATH = join(tmpdir(), 'missing-tar');
    process.env.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH = join(tmpdir(), 'missing-chromium');
    process.env.PATH = '';
    applyMinimumEnv();

    const { inspectRuntimeDependencies, validateRuntimeDependencies } = await import('@/utils/runtime-dependencies');

    const report = await inspectRuntimeDependencies('api');
    expect(report.dependencies.every((dependency) => dependency.status !== 'missing')).toBe(true);
    await expect(validateRuntimeDependencies('api')).resolves.toBeDefined();
  });
});
