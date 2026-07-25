import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { locateCondaExecutablePath, resolveCondaExecutablePath } from './executable';
import type { CondaInfo } from './parsers';

const MAX_CONFIG_FILE_BYTES = 8 * 1024 * 1024;
const CONFIG_LOCATION_VARIABLES = new Set([
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
]);

export interface CachedCondaInfo {
  readonly executable: string;
  readonly path: string | undefined;
  readonly updatedAt: number;
  readonly coherenceFingerprint?: string;
  readonly info: CondaInfo;
}

function configSources(info: CondaInfo): readonly string[] {
  return [
    ...new Set(
      [...(info.configFiles ?? []), info.rcPath, info.userRcPath, info.sysRcPath]
        .filter((source): source is string => source !== undefined && source.trim() !== '')
        .map((source) => path.normalize(path.resolve(source))),
    ),
  ].sort();
}

function relevantEnvironment(
  environment: NodeJS.ProcessEnv,
): readonly (readonly [string, string])[] {
  return Object.entries(environment)
    .filter(([name, value]) => {
      if (value === undefined) {
        return false;
      }
      const normalized = name.toUpperCase();
      return (
        normalized.startsWith('CONDA') ||
        normalized.startsWith('_CE_CONDA') ||
        CONFIG_LOCATION_VARIABLES.has(normalized)
      );
    })
    .map(([name, value]) => [name.toUpperCase(), value as string] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

async function addPathIdentity(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | undefined,
  includeContents: boolean,
): Promise<void> {
  hash.update(JSON.stringify([label, value]));
  if (value === undefined) {
    return;
  }
  try {
    const lexical = await lstat(value);
    hash.update(
      JSON.stringify([lexical.mode, lexical.size, lexical.mtimeMs, lexical.ctimeMs, lexical.ino]),
    );
  } catch {
    hash.update('missing');
    return;
  }

  try {
    hash.update(await realpath(value));
  } catch {
    hash.update('unresolved');
  }
  if (!includeContents) {
    return;
  }
  try {
    const target = await stat(value);
    if (target.isFile() && target.size <= MAX_CONFIG_FILE_BYTES) {
      hash.update(await readFile(value));
    } else {
      hash.update(JSON.stringify([target.mode, target.size, target.mtimeMs, target.ctimeMs]));
    }
  } catch {
    hash.update('unreadable');
  }
}

export async function condaInfoCoherenceFingerprint(
  executable: string,
  info: CondaInfo,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([executable, relevantEnvironment(environment)]));

  const lexicalExecutable = await locateCondaExecutablePath(executable, environment);
  const resolvedExecutable = await resolveCondaExecutablePath(executable, environment);
  await addPathIdentity(hash, 'executable', lexicalExecutable, false);
  if (resolvedExecutable !== lexicalExecutable) {
    await addPathIdentity(hash, 'resolved-executable', resolvedExecutable, false);
  }
  for (const source of configSources(info)) {
    await addPathIdentity(hash, 'config', source, true);
  }
  return hash.digest('hex');
}

export function isCachedCondaInfoCoherent(
  cached: CachedCondaInfo | undefined,
  currentFingerprint: string,
): boolean {
  return (
    cached?.coherenceFingerprint !== undefined && cached.coherenceFingerprint === currentFingerprint
  );
}

export function isCachedCondaInfoFresh(
  cached: CachedCondaInfo | undefined,
  now: number,
  maximumAge: number,
): boolean {
  return (
    cached !== undefined &&
    Number.isFinite(cached.updatedAt) &&
    cached.updatedAt > 0 &&
    now >= cached.updatedAt &&
    now - cached.updatedAt < maximumAge
  );
}
