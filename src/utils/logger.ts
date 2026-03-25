import pino, { type Logger } from 'pino';
import { config as appConfig } from '@/config';

const loggers = new Map<string, Logger>();
const recentLogs: Array<{
  id: string;
  timestamp: string;
  logger: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}> = [];
const MAX_RECENT_LOGS = 500;
const PINO_LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

let runtimeLogLevel = appConfig.LOG_LEVEL;

function pushRecentLog(entry: {
  logger: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}) {
  recentLogs.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });

  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.splice(0, recentLogs.length - MAX_RECENT_LOGS);
  }
}

export function createLogger(name: string): Logger {
  if (loggers.has(name)) {
    return loggers.get(name)!;
  }

  const logger = pino({
    level: runtimeLogLevel,
    base: { name },
    hooks: {
      logMethod(args, method, level) {
        const context =
          args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
            ? (args[0] as Record<string, unknown>)
            : undefined;
        const message =
          typeof args[0] === 'string'
            ? args[0]
            : typeof args[1] === 'string'
              ? args[1]
              : 'Log event';

        pushRecentLog({
          logger: name,
          level: PINO_LEVEL_NAMES[level] ?? String(level),
          message,
          context,
        });

        method.apply(this, args as Parameters<typeof method>);
      },
    },
    transport:
      appConfig.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: false,
            },
          }
        : undefined,
  });

  loggers.set(name, logger);
  return logger;
}

export function getLogger(name: string): Logger {
  const logger = loggers.get(name);
  if (!logger) {
    throw new Error(`Logger "${name}" not found`);
  }
  return logger;
}

export function getRecentLogs(options?: { level?: string; limit?: number }) {
  const level = options?.level?.toLowerCase();
  const filtered = level ? recentLogs.filter((entry) => entry.level === level) : recentLogs;
  const limit = options?.limit ? Math.max(1, options.limit) : 100;
  return filtered.slice(-limit).reverse();
}

export function setRuntimeLogLevel(level: typeof appConfig.LOG_LEVEL) {
  runtimeLogLevel = level;
  for (const logger of loggers.values()) {
    logger.level = level;
  }
}

export function getRuntimeLogLevel() {
  return runtimeLogLevel;
}
