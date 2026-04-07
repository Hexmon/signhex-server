export const PROCESS_ROLES = ['all', 'api', 'worker'] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

function isProcessRole(value: string): value is ProcessRole {
  return (PROCESS_ROLES as readonly string[]).includes(value);
}

export function resolveProcessRole(args: string[] = process.argv.slice(2), env = process.env): ProcessRole {
  const cliRole = args.find((arg) => arg.startsWith('--role='))?.slice('--role='.length)?.trim();
  if (cliRole) {
    if (!isProcessRole(cliRole)) {
      throw new Error(`Unsupported process role: ${cliRole}`);
    }
    return cliRole;
  }

  const envRole = env.HEXMON_PROCESS_ROLE?.trim();
  if (envRole) {
    if (!isProcessRole(envRole)) {
      throw new Error(`Unsupported process role: ${envRole}`);
    }
    return envRole;
  }

  return 'all';
}
