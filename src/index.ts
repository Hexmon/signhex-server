process.setMaxListeners(20);

import { createLogger } from '@/utils/logger';
import { resolveProcessRole } from '@/runtime/process-role';
import { startRuntime, stopRuntime, type RuntimeContext } from '@/runtime/bootstrap';

const logger = createLogger('main');

async function main() {
  try {
    const role = resolveProcessRole();
    logger.info({ role }, 'Starting runtime');
    const runtime = await startRuntime(role);

    // Graceful shutdown
    const shutdown = async (signal: 'SIGTERM' | 'SIGINT', runtime: RuntimeContext) => {
      logger.info({ role: runtime.role, signal }, 'Shutdown signal received');
      await stopRuntime(runtime);
      process.exit(0);
    };

    process.on('SIGTERM', async () => {
      await shutdown('SIGTERM', runtime);
    });

    process.on('SIGINT', async () => {
      await shutdown('SIGINT', runtime);
    });
  } catch (error) {
    logger.error(error, 'Fatal error during startup');
    process.exit(1);
  }
}

main();
