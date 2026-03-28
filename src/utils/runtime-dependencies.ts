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

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
    appConfig.LIBREOFFICE_PATH,
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
  const configured = appConfig.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH?.trim();
  if (configured) {
    const resolvedConfigured = findExecutableCandidate(configured);
    if (!resolvedConfigured) {
      throw new Error(`Configured Chromium executable not found at ${configured}`);
    }

    return resolvedConfigured;
  }

  try {
    const { chromium } = await import('playwright');
    const candidate = chromium.executablePath();
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  } catch (error) {
    throw new Error(`Playwright Chromium is not available: ${normalizeErrorMessage(error)}`);
  }

  throw new Error('Playwright Chromium executable is not installed. Run "npx playwright install chromium" or set HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH.');
}

function resolvePgDumpPath() {
  return dedupeCandidates([appConfig.PG_DUMP_PATH, 'pg_dump']).map(findExecutableCandidate).find(Boolean) || null;
}

function resolveTarPath() {
  return dedupeCandidates([appConfig.TAR_PATH, 'tar']).map(findExecutableCandidate).find(Boolean) || null;
}

export function getResolvedPgDumpPath() {
  return resolvePgDumpPath();
}

export function getResolvedTarPath() {
  return resolveTarPath();
}

export async function getResolvedChromiumExecutable() {
  return resolveChromiumPath();
}

export async function inspectRuntimeDependencies(): Promise<RuntimeDependencyReport> {
  const ffmpegPath = resolveFfmpegPath();
  const libreOfficePath = resolveLibreOfficePath();
  const pgDumpPath = resolvePgDumpPath();
  const tarPath = resolveTarPath();
  let chromiumPath: string | null = null;
  let chromiumDetail: string | undefined;

  try {
    chromiumPath = await resolveChromiumPath();
  } catch (error) {
    chromiumDetail = normalizeErrorMessage(error);
  }

  return {
    runningInContainer: runningInContainer(),
    dependencies: [
      {
        name: 'ffmpeg',
        status: ffmpegPath ? 'available' : 'missing',
        path: ffmpegPath || undefined,
        detail: ffmpegPath ? undefined : 'Install ffmpeg or set FFMPEG_PATH to the executable.',
      },
      {
        name: 'libreoffice',
        status: libreOfficePath ? 'available' : 'missing',
        path: libreOfficePath || undefined,
        detail: libreOfficePath ? undefined : 'Install LibreOffice/soffice or set LIBREOFFICE_PATH to the executable.',
      },
      {
        name: 'chromium',
        status: chromiumPath ? 'available' : 'missing',
        path: chromiumPath || undefined,
        detail:
          chromiumPath
            ? undefined
            : chromiumDetail ||
              'Install Playwright Chromium with "npx playwright install chromium" or set HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH.',
      },
      {
        name: 'pg_dump',
        status: pgDumpPath ? 'available' : 'missing',
        path: pgDumpPath || undefined,
        detail: pgDumpPath ? undefined : 'Install pg_dump or set PG_DUMP_PATH to the executable.',
      },
      {
        name: 'tar',
        status: tarPath ? 'available' : 'missing',
        path: tarPath || undefined,
        detail: tarPath ? undefined : 'Install tar or set TAR_PATH to the executable.',
      },
    ],
  };
}

export async function validateRuntimeDependencies() {
  const report = await inspectRuntimeDependencies();
  const missingCritical = report.dependencies.filter((dependency) => dependency.status === 'missing');

  if (missingCritical.length > 0) {
    throw new Error(
      `Missing required runtime dependencies: ${missingCritical
        .map((dependency) => dependency.name)
        .join(', ')}. Install the missing tools on the host or configure FFMPEG_PATH, LIBREOFFICE_PATH, PG_DUMP_PATH, TAR_PATH, and HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH as needed.`
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
