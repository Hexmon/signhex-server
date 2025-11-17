import pino, { type Logger } from 'pino';
import { config as appConfig } from '@/config';

const loggers = new Map<string, Logger>();

export function createLogger(name: string): Logger {
  if (loggers.has(name)) {
    return loggers.get(name)!;
  }
  const logger = pino({
    level: appConfig.LOG_LEVEL,
    base: { name },
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

