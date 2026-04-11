#!/usr/bin/env tsx

import { inspectRuntimeDependencies } from '../src/utils/runtime-dependencies.js';

async function main() {
  const report = await inspectRuntimeDependencies();
  console.log(JSON.stringify(report, null, 2));

  const missing = report.dependencies.filter((dependency) => dependency.status === 'missing');
  process.exit(missing.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
