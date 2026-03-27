import { accessSync, constants, existsSync } from 'fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'path';
import { createLogger } from '@/utils/logger';
import { config as appConfig } from '@/config';

const logger = createLogger('runtime-dependencies');

export type RuntimeDependencyStatus = 'available' | 'missing' | 'optional';

export interface RuntimeDependency {
  name: 'ffmpeg' | 'libreoffice' | 'chromium' | 'pg_dump' | 'tar';
  status: RuntimeDependencyStatus;
  path?: string;
  detail?: string;
}

export interface RuntimeDependencyReport {
  runningInContainer: boolean;
  dependencies: RuntimeDependency[];
}

function runningInContainer() {
  return process.env.HEXMON_RUNTIME_CONTAINER === 'true' || existsSync('/.dockerenv');
}

function dedupeCandidates(candidates: Array<string | undefined>) {
  return Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate && candidate.trim()))));
}

function findExecutableCandidate(candidate: string) {
  const treatAsPath = isAbsolute(candidate) || candidate.includes(sep) || (sep === '\\' && candidate.includes('/'));
  const resolvedCandidate = treatAsPath ? resolve(candidate) : candidate;
  const searchPath = !treatAsPath;
  const pathEntries = searchPath ? (process.env.PATH || '').split(delimiter).filter(Boolean) : [''];
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];

  const searchTargets =
    !searchPath || pathEntries.length === 0
      ? [resolvedCandidate]
      : pathEntries.flatMap((entry) => extensions.map((extension) => join(entry, `${resolvedCandidate}${extension}`)));

  for (const target of searchTargets) {
    try {
      accessSync(target, constants.X_OK);
      return target;
    } catch {
      // keep searching
    }
  }

  return null;
}

function resolveFfmpegPath() {
  return dedupeCandidates([appConfig.FFMPEG_PATH, 'ffmpeg']).map(findExecutableCandidate).find(Boolean) || null;
}

function resolveLibreOfficePath() {
  const candidates = dedupeCandidates([
    process.env.LIBREOFFICE_PATH,
    'soffice',
    process.platform === 'win32' ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : undefined,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe' : undefined,
  ]);

  return candidates.map(findExecutableCandidate).find(Boolean) || null;
}

export function getLibreOfficeExecutable() {
  return resolveLibreOfficePath();
}

export function getResolvedFfmpegPath() {
  return resolveFfmpegPath();
}

async function resolveChromiumPath() {
  const configured = process.env.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH?.trim();
  if (configured) {
    return findExecutableCandidate(configured);
  }

  try {
    const { chromium } = await import('playwright');
    const candidate = chromium.executablePath();
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  } catch (error) {
    return `ERROR:${error instanceof Error ? error.message : String(error)}`;
  }

  return null;
}

function resolvePgDumpPath() {
  return findExecutableCandidate('pg_dump');
}

function resolveTarPath() {
  return findExecutableCandidate('tar');
}

export async function inspectRuntimeDependencies(): Promise<RuntimeDependencyReport> {
  const ffmpegPath = resolveFfmpegPath();
  const libreOfficePath = resolveLibreOfficePath();
  const chromiumPath = await resolveChromiumPath();
  const pgDumpPath = resolvePgDumpPath();
  const tarPath = resolveTarPath();

  return {
    runningInContainer: runningInContainer(),
    dependencies: [
      {
        name: 'ffmpeg',
        status: ffmpegPath ? 'available' : 'missing',
        path: ffmpegPath || undefined,
      },
      {
        name: 'libreoffice',
        status:
          libreOfficePath || process.platform === 'darwin'
            ? 'available'
            : 'missing',
        path: libreOfficePath || undefined,
        detail: process.platform === 'darwin' && !libreOfficePath ? 'macOS QuickLook fallback remains available for host-run development' : undefined,
      },
      {
        name: 'chromium',
        status: chromiumPath && !chromiumPath.startsWith('ERROR:') ? 'available' : 'missing',
        path: chromiumPath && !chromiumPath.startsWith('ERROR:') ? chromiumPath : undefined,
        detail: chromiumPath?.startsWith('ERROR:') ? chromiumPath.replace(/^ERROR:/, '') : undefined,
      },
      {
        name: 'pg_dump',
        status: pgDumpPath ? 'available' : 'missing',
        path: pgDumpPath || undefined,
        detail: pgDumpPath ? undefined : 'host backups can fall back to docker exec when Docker is available',
      },
      {
        name: 'tar',
        status: tarPath ? 'available' : 'missing',
        path: tarPath || undefined,
      },
    ],
  };
}

export async function validateRuntimeDependencies() {
  const report = await inspectRuntimeDependencies();
  const missingCritical = report.dependencies.filter((dependency) => dependency.status === 'missing');

  if (report.runningInContainer && missingCritical.length > 0) {
    throw new Error(
      `Container runtime is missing required dependencies: ${missingCritical.map((dependency) => dependency.name).join(', ')}`
    );
  }

  if (missingCritical.length > 0) {
    logger.warn(
      {
        runningInContainer: report.runningInContainer,
        missing: missingCritical,
      },
      'Runtime dependency gaps detected. Prefer the official container runtime for media processing and backups.'
    );
  } else {
    logger.info(
      {
        runningInContainer: report.runningInContainer,
        dependencies: report.dependencies,
      },
      'Runtime dependencies validated successfully'
    );
  }

  return report;
}
