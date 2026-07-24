import { existsSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { CondaInfo } from './parsers';
import { normalizeEnvironmentPath } from './workspaceRouting';

export type CondaPrefixKind = 'base' | 'named' | 'prefix';

export interface CondaPrefixMetadata {
  readonly prefix: string;
  readonly name: string;
  readonly kind: CondaPrefixKind;
  readonly pythonPath: string;
  readonly pythonVersion: string | null;
  readonly pythonExists: boolean;
  readonly condaInstallation: boolean;
}

interface CondaPackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly subdir?: unknown;
}

function expandUser(value: string, userHome: string): string {
  if (value === '~') {
    return userHome;
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(userHome, value.slice(2));
  }
  return value;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(
    normalizeEnvironmentPath(root),
    normalizeEnvironmentPath(candidate),
  );
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function condaGlobalEnvironmentRoots(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): readonly string[] {
  const configured = environment.CONDA_GLOBAL_HOME?.trim();
  if (configured) {
    return [resolvedEnvironmentRoot(path.join(expandUser(configured, userHome), 'envs'))];
  }

  const currentManifest = path.join(userHome, '.conda', 'global.toml');
  const legacyData = path.join(userHome, '.cg');
  const dataRoot =
    existsSync(currentManifest) && statSync(currentManifest).isFile()
      ? path.join(userHome, '.conda', 'global')
      : existsSync(legacyData) && statSync(legacyData).isDirectory()
        ? legacyData
        : path.join(userHome, '.conda', 'global');
  return [resolvedEnvironmentRoot(path.join(dataRoot, 'envs'))];
}

export function isCondaGlobalPrefix(
  prefix: string,
  roots: readonly string[] = condaGlobalEnvironmentRoots(),
): boolean {
  const resolvedPrefix = resolvedEnvironmentRoot(prefix);
  return roots.some((root) => isPathWithin(root, resolvedPrefix));
}

export function isPixiEnvironmentPrefix(prefix: string): boolean {
  const portable = prefix.replaceAll('\\', '/').toLocaleLowerCase();
  return portable.includes('/.pixi/envs/') || portable.endsWith('/.pixi/envs');
}

export function isManagedProjectPrefix(prefix: string, projectRoot: string): boolean {
  return (
    normalizeEnvironmentPath(prefix) === normalizeEnvironmentPath(path.join(projectRoot, '.conda'))
  );
}

export function pythonExecutablePath(prefix: string, condaPlatform: string): string {
  const pathFlavor =
    process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(prefix) ? path.win32 : path;
  return condaPlatform.startsWith('win-')
    ? pathFlavor.join(prefix, 'python.exe')
    : pathFlavor.join(prefix, 'bin', 'python');
}

function resolvedEnvironmentRoot(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  try {
    return normalizeEnvironmentPath(realpathSync.native(resolved));
  } catch {
    return normalizeEnvironmentPath(resolved);
  }
}

function detailName(prefix: string, info: CondaInfo): string | undefined {
  const expected = normalizeEnvironmentPath(prefix);
  return Object.entries(info.envsDetails).find(
    ([candidate]) => normalizeEnvironmentPath(candidate) === expected,
  )?.[1].name;
}

function classifyPrefix(
  prefix: string,
  info: CondaInfo,
): { readonly kind: CondaPrefixKind; readonly name: string } {
  const normalized = normalizeEnvironmentPath(prefix);
  if (normalized === normalizeEnvironmentPath(info.rootPrefix)) {
    return { kind: 'base', name: 'base' };
  }

  const configuredName = detailName(prefix, info)?.trim();
  const named =
    (configuredName !== undefined && configuredName !== '') ||
    info.envsDirs.some(
      (envsDir) =>
        normalizeEnvironmentPath(path.dirname(prefix)) === normalizeEnvironmentPath(envsDir),
    );
  return {
    kind: named ? 'named' : 'prefix',
    name: configuredName || path.basename(prefix),
  };
}

interface PrefixPython {
  readonly version: string;
  readonly subdir?: string;
}

async function pythonFromPrefix(prefix: string): Promise<PrefixPython | null> {
  let entries: string[];
  try {
    entries = await readdir(path.join(prefix, 'conda-meta'));
  } catch {
    return null;
  }

  for (const entry of entries.filter(
    (name) => name.startsWith('python-') && name.endsWith('.json'),
  )) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(prefix, 'conda-meta', entry), 'utf8'),
      ) as CondaPackageMetadata;
      if (parsed.name === 'python' && typeof parsed.version === 'string') {
        return {
          version: parsed.version,
          ...(typeof parsed.subdir === 'string' && parsed.subdir !== ''
            ? { subdir: parsed.subdir }
            : {}),
        };
      }
    } catch {
      // A broken package record should not hide other usable Python records.
    }
  }
  return null;
}

export async function inspectCondaPrefix(
  prefix: string,
  info: CondaInfo,
): Promise<CondaPrefixMetadata | undefined> {
  const resolved = path.normalize(path.resolve(prefix));
  try {
    if (!(await stat(path.join(resolved, 'conda-meta'))).isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const python = await pythonFromPrefix(resolved);
  const pythonPath = pythonExecutablePath(resolved, python?.subdir ?? info.platform);
  let pythonExists = false;
  try {
    pythonExists = (await stat(pythonPath)).isFile();
  } catch {
    pythonExists = false;
  }
  const condaInstallation =
    (await isDirectory(path.join(resolved, 'condabin'))) ||
    ((await isDirectory(path.join(resolved, 'pkgs'))) &&
      (await isDirectory(path.join(resolved, 'envs'))));
  const classification = classifyPrefix(resolved, info);
  return {
    prefix: resolved,
    name: classification.name,
    kind: classification.kind,
    pythonPath,
    pythonVersion: python?.version ?? null,
    pythonExists,
    condaInstallation,
  };
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}
