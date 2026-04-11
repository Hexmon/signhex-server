import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeDatabase = vi.fn();
const initializeS3 = vi.fn();
const createBucketIfNotExists = vi.fn();
const initializeJobs = vi.fn();
const registerJobHandlers = vi.fn();
const scheduleRecurringJobs = vi.fn();
const stopJobs = vi.fn();
const validateRuntimeDependencies = vi.fn();
const listen = vi.fn();
const close = vi.fn();
const createServer = vi.fn(async () => ({ listen, close }));

vi.mock('@/db', () => ({
  initializeDatabase,
}));

vi.mock('@/s3', () => ({
  initializeS3,
  createBucketIfNotExists,
}));

vi.mock('@/jobs', () => ({
  initializeJobs,
  registerJobHandlers,
  scheduleRecurringJobs,
  stopJobs,
}));

vi.mock('@/server', () => ({
  createServer,
}));

vi.mock('@/utils/runtime-dependencies', () => ({
  validateRuntimeDependencies,
}));

describe('runtime bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts api role without worker handlers', async () => {
    const { startRuntime } = await import('@/runtime/bootstrap');
    const runtime = await startRuntime('api');

    expect(validateRuntimeDependencies).toHaveBeenCalledWith('api');
    expect(initializeDatabase).toHaveBeenCalled();
    expect(initializeS3).toHaveBeenCalled();
    expect(initializeJobs).toHaveBeenCalled();
    expect(registerJobHandlers).not.toHaveBeenCalled();
    expect(scheduleRecurringJobs).not.toHaveBeenCalled();
    expect(createServer).toHaveBeenCalled();
    expect(listen).toHaveBeenCalled();
    expect(runtime.role).toBe('api');
    expect(runtime.fastify).toBeDefined();
  });

  it('starts worker role without binding the api server', async () => {
    const { startRuntime } = await import('@/runtime/bootstrap');
    const runtime = await startRuntime('worker');

    expect(validateRuntimeDependencies).toHaveBeenCalledWith('worker');
    expect(initializeJobs).toHaveBeenCalled();
    expect(registerJobHandlers).toHaveBeenCalled();
    expect(scheduleRecurringJobs).toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(runtime.fastify).toBeUndefined();
  });

  it('stops both fastify and jobs when api runtime is shut down', async () => {
    const { stopRuntime } = await import('@/runtime/bootstrap');
    await stopRuntime({ role: 'api', fastify: { close } as any });

    expect(close).toHaveBeenCalled();
    expect(stopJobs).toHaveBeenCalled();
  });
});
