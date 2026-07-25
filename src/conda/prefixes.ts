import { existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { CondaInfo } from './parsers';
import { isRunnableCondaExecutable } from './executable';
import { canonicalEnvironmentPath, normalizeEnvironmentPath } from './workspaceRouting';

export type CondaPrefixKind = 'base' | 'named' | 'prefix';

export interface CondaPrefixMetadata {
  readonly prefix: string;
  readonly name: string;
  readonly kind: CondaPrefixKind;
  readonly pythonPath: string;
  readonly pythonVersion: string | null;
  readonly pythonExists: boolean;
  readonly condaInstallation: boolean;
  readonly ownerRoot?: string;
  readonly ownerExecutable?: string;
  readonly ownerEnvsDir?: string;
}

export interface CondaPrefixInspectionOptions {
  readonly ownerRoot?: string;
  readonly ownerExecutable?: string;
  readonly ownerEnvsDirs?: readonly string[];
  readonly primaryRootTrusted?: boolean;
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
  const canonicalRoot = canonicalEnvironmentPath(root);
  const canonicalCandidate = canonicalEnvironmentPath(candidate);
  const rootUsesWindowsPath = /^[a-z]:[\\/]/i.test(canonicalRoot);
  const candidateUsesWindowsPath = /^[a-z]:[\\/]/i.test(canonicalCandidate);
  if (rootUsesWindowsPath !== candidateUsesWindowsPath) {
    return false;
  }
  const pathFlavor = rootUsesWindowsPath ? path.win32 : path;
  const relative = pathFlavor.relative(canonicalRoot, canonicalCandidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${pathFlavor.sep}`) &&
      !pathFlavor.isAbsolute(relative))
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
  return roots.some((root) => isPathWithin(root, prefix));
}

export function isPixiEnvironmentPrefix(prefix: string): boolean {
  const portable = canonicalEnvironmentPath(prefix).replaceAll('\\', '/').toLowerCase();
  return portable.includes('/.pixi/envs/') || portable.endsWith('/.pixi/envs');
}

export function isManagedProjectPrefix(prefix: string, projectRoot: string): boolean {
  return (
    canonicalEnvironmentPath(prefix) === canonicalEnvironmentPath(path.join(projectRoot, '.conda'))
  );
}

export async function isRemovableManagedProjectPrefix(
  prefix: string,
  projectRoot: string,
): Promise<boolean> {
  return (
    isManagedProjectPrefix(prefix, projectRoot) &&
    (await isRemovableCondaPrefix(prefix, projectRoot))
  );
}

export async function isRemovableCondaPrefix(
  prefix: string,
  trustedParent?: string,
): Promise<boolean> {
  try {
    const resolved = path.normalize(path.resolve(prefix));
    const [metadata, condaMetadata] = await Promise.all([
      lstat(resolved),
      lstat(path.join(resolved, 'conda-meta')),
    ]);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      condaMetadata.isDirectory() &&
      !condaMetadata.isSymbolicLink() &&
      (trustedParent === undefined ||
        normalizeEnvironmentPath(await canonicalCondaPath(path.dirname(resolved))) ===
          normalizeEnvironmentPath(await canonicalCondaPath(trustedParent)))
    );
  } catch {
    return false;
  }
}

export function condaPrefixCandidates(value: string): readonly string[] {
  const resolved = path.normalize(path.resolve(value));
  const candidates = [resolved];
  const basename = path.basename(resolved);
  const parent = path.dirname(resolved);
  if (/^python(?:\d+(?:\.\d+)*)?$/i.test(basename) && path.basename(parent) === 'bin') {
    candidates.push(path.dirname(parent));
  } else if (/^python(?:\d+(?:\.\d+)*)?\.exe$/i.test(basename)) {
    candidates.push(parent);
  }
  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
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

interface PrefixPython {
  readonly version: string;
  readonly subdir?: string;
}

interface CondaPrefixCreation {
  readonly kind?: 'named' | 'prefix';
  readonly name?: string;
  readonly ownerRoot?: string;
  readonly ownerExecutable?: string;
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

export async function canonicalCondaPath(value: string): Promise<string> {
  const resolved = path.normalize(path.resolve(value));
  try {
    return path.normalize(await realpath(resolved));
  } catch {
    return resolved;
  }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function commandExecutable(command: string): string | undefined {
  const value = command.trim();
  if (value === '') {
    return undefined;
  }
  const creation = /\s+(?:env\s+)?create(?:\s|$)/i.exec(value);
  if (creation !== null) {
    return unquote(value.slice(0, creation.index).trim());
  }
  return value.match(/^\S+/)?.[0];
}

function commandOption(command: string, shortName: string, longName: string): string | undefined {
  const match = command.match(
    new RegExp(`(?:^|\\s)(?:${shortName}|${longName})(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'i'),
  );
  return match?.[1] === undefined ? undefined : unquote(match[1]);
}

export function condaInstallationRootFromExecutable(value: string): string | undefined {
  const pathFlavor = /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path;
  if (!pathFlavor.isAbsolute(value)) {
    return undefined;
  }

  const executable = pathFlavor.normalize(value);
  const directory = pathFlavor.dirname(executable);
  const directoryName = pathFlavor.basename(directory).toLowerCase();
  if (['bin', 'scripts', 'condabin'].includes(directoryName)) {
    return pathFlavor.dirname(directory);
  }

  const portable = executable.replaceAll('\\', '/');
  const sitePackages = portable.toLowerCase().indexOf('/site-packages/conda/__main__.py');
  if (sitePackages >= 0) {
    const library = portable.toLowerCase().lastIndexOf('/lib/', sitePackages);
    if (library >= 0) {
      return pathFlavor.normalize(portable.slice(0, library).replaceAll('/', pathFlavor.sep));
    }
  }

  if (['_conda', '_conda.exe'].includes(pathFlavor.basename(executable).toLowerCase())) {
    return directory;
  }
  return undefined;
}

async function prefixCreation(prefix: string): Promise<CondaPrefixCreation> {
  let contents: string;
  try {
    contents = await readFile(path.join(prefix, 'conda-meta', 'history'), 'utf8');
  } catch {
    return {};
  }

  const line = contents
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /^# cmd:/i.test(item) && /\screate(?:\s|$)/i.test(item));
  if (line === undefined) {
    return {};
  }

  const command = line.replace(/^# cmd:\s*/i, '');
  const name = commandOption(command, '-n', '--name');
  const explicitPrefix = commandOption(command, '-p', '--prefix');
  const commandPath = commandExecutable(command);
  const executable =
    commandPath !== undefined && path.isAbsolute(commandPath)
      ? await canonicalCondaPath(commandPath)
      : commandPath;
  const ownerRoot =
    executable === undefined ? undefined : condaInstallationRootFromExecutable(executable);
  const ownerExecutable =
    executable === undefined || !isRunnableCondaExecutable(executable) ? undefined : executable;
  return {
    ...(explicitPrefix === undefined
      ? name === undefined
        ? {}
        : { kind: 'named' as const, name }
      : { kind: 'prefix' as const }),
    ...(ownerRoot === undefined ? {} : { ownerRoot }),
    ...(ownerExecutable === undefined || ownerRoot === undefined ? {} : { ownerExecutable }),
  };
}

export async function findCondaExecutable(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const candidates =
    platform === 'win32'
      ? [
          path.join(root, 'Scripts', 'conda.exe'),
          path.join(root, 'condabin', 'conda.exe'),
          path.join(root, '_conda.exe'),
        ]
      : [
          path.join(root, 'bin', 'conda'),
          path.join(root, 'condabin', 'conda'),
          path.join(root, '_conda'),
        ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return canonicalCondaPath(candidate);
      }
    } catch {
      // Try the next supported installation layout.
    }
  }
  return undefined;
}

export async function isCondaInstallationRoot(root: string): Promise<boolean> {
  if (!(await isDirectory(path.join(root, 'conda-meta')))) {
    return false;
  }
  return (
    (await isDirectory(path.join(root, 'condabin'))) ||
    ((await isDirectory(path.join(root, 'pkgs'))) &&
      (await isDirectory(path.join(root, 'envs')))) ||
    (await findCondaExecutable(root)) !== undefined
  );
}

async function directChildDirectory(
  prefix: string,
  directories: readonly string[],
): Promise<string | undefined> {
  const parent = normalizeEnvironmentPath(path.dirname(await canonicalCondaPath(prefix)));
  for (const directory of directories) {
    if (normalizeEnvironmentPath(await canonicalCondaPath(directory)) === parent) {
      return path.normalize(path.resolve(directory));
    }
  }
  return undefined;
}

function sameEnvironmentName(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function inspectCondaPrefix(
  prefix: string,
  info: CondaInfo,
  options: CondaPrefixInspectionOptions = {},
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
  const resolvedIdentity = await canonicalCondaPath(resolved);
  const primaryRoot = path.normalize(path.resolve(info.rootPrefix));
  const primaryRootIdentity = await canonicalCondaPath(primaryRoot);
  const primaryRootUsable =
    (options.primaryRootTrusted ?? true) || (await isCondaInstallationRoot(primaryRoot));
  const detectedCondaInstallation =
    (primaryRootUsable &&
      normalizeEnvironmentPath(resolvedIdentity) ===
        normalizeEnvironmentPath(primaryRootIdentity)) ||
    (await isCondaInstallationRoot(resolved));
  const creation = await prefixCreation(resolved);
  const configuredOwnerRoot =
    options.ownerRoot === undefined ? undefined : path.normalize(path.resolve(options.ownerRoot));
  const historyOwnerRoot =
    creation.ownerRoot === undefined ? undefined : path.normalize(path.resolve(creation.ownerRoot));
  const historyOwnerParent =
    historyOwnerRoot !== undefined &&
    path.basename(path.dirname(historyOwnerRoot)).toLowerCase() === 'envs'
      ? path.dirname(path.dirname(historyOwnerRoot))
      : undefined;
  const usableHistoryOwnerRoot =
    historyOwnerRoot !== undefined &&
    (historyOwnerParent === undefined || !(await isCondaInstallationRoot(historyOwnerParent))) &&
    (await isCondaInstallationRoot(historyOwnerRoot))
      ? historyOwnerRoot
      : undefined;
  const layoutOwnerCandidate =
    path.basename(path.dirname(resolvedIdentity)).toLowerCase() === 'envs'
      ? path.dirname(path.dirname(resolvedIdentity))
      : undefined;
  const layoutOwnerRoot =
    layoutOwnerCandidate !== undefined && (await isCondaInstallationRoot(layoutOwnerCandidate))
      ? layoutOwnerCandidate
      : undefined;
  const externalOwnerRoot = layoutOwnerRoot ?? configuredOwnerRoot ?? usableHistoryOwnerRoot;
  const externalOwnerIdentity =
    externalOwnerRoot === undefined ? undefined : await canonicalCondaPath(externalOwnerRoot);
  const condaInstallation =
    detectedCondaInstallation &&
    (externalOwnerIdentity === undefined ||
      normalizeEnvironmentPath(externalOwnerIdentity) ===
        normalizeEnvironmentPath(resolvedIdentity));
  const primaryEnvironmentDirectories = info.envsDirs;
  const primaryEnvironmentDirectory = primaryRootUsable
    ? await directChildDirectory(resolved, primaryEnvironmentDirectories)
    : undefined;
  const ownerRoot = condaInstallation
    ? resolved
    : (layoutOwnerRoot ??
      configuredOwnerRoot ??
      usableHistoryOwnerRoot ??
      (primaryEnvironmentDirectory === undefined ? undefined : primaryRoot));
  const ownerEnvsDirs = [
    ...(options.ownerEnvsDirs ?? []),
    ...(ownerRoot !== undefined &&
    normalizeEnvironmentPath(await canonicalCondaPath(ownerRoot)) ===
      normalizeEnvironmentPath(primaryRootIdentity)
      ? primaryEnvironmentDirectories
      : []),
    ...(ownerRoot === undefined ? [] : [path.join(ownerRoot, 'envs')]),
  ];
  const configuredName = detailName(resolved, info)?.trim();
  const historyName =
    creation.kind === 'named' &&
    creation.name !== undefined &&
    sameEnvironmentName(creation.name, path.basename(resolved))
      ? creation.name
      : undefined;
  const ownerEnvsDir =
    ownerRoot === undefined ? undefined : await directChildDirectory(resolved, ownerEnvsDirs);
  const kind: CondaPrefixKind = condaInstallation
    ? 'base'
    : configuredName !== undefined && configuredName !== ''
      ? 'named'
      : ownerEnvsDir !== undefined
        ? 'named'
        : historyName !== undefined
          ? 'named'
          : ownerRoot === undefined && pythonExists
            ? 'named'
            : 'prefix';
  const installedOwnerExecutable =
    ownerRoot === undefined ? undefined : await findCondaExecutable(ownerRoot);
  const usableHistoryOwnerIdentity =
    usableHistoryOwnerRoot === undefined
      ? undefined
      : await canonicalCondaPath(usableHistoryOwnerRoot);
  const ownerIdentity = ownerRoot === undefined ? undefined : await canonicalCondaPath(ownerRoot);
  const configuredOwnerIdentity =
    configuredOwnerRoot === undefined ? undefined : await canonicalCondaPath(configuredOwnerRoot);
  const configuredOwnerExecutable =
    options.ownerExecutable !== undefined &&
    isRunnableCondaExecutable(options.ownerExecutable) &&
    configuredOwnerIdentity !== undefined &&
    ownerIdentity !== undefined &&
    normalizeEnvironmentPath(configuredOwnerIdentity) === normalizeEnvironmentPath(ownerIdentity)
      ? options.ownerExecutable
      : undefined;
  const ownerExecutable =
    configuredOwnerExecutable ??
    installedOwnerExecutable ??
    (usableHistoryOwnerIdentity !== undefined &&
    ownerIdentity !== undefined &&
    normalizeEnvironmentPath(usableHistoryOwnerIdentity) === normalizeEnvironmentPath(ownerIdentity)
      ? creation.ownerExecutable
      : undefined);
  return {
    prefix: resolved,
    name: kind === 'base' ? 'base' : configuredName || historyName || path.basename(resolved),
    kind,
    pythonPath,
    pythonVersion: python?.version ?? null,
    pythonExists,
    condaInstallation,
    ...(ownerRoot === undefined ? {} : { ownerRoot }),
    ...(ownerExecutable === undefined ? {} : { ownerExecutable }),
    ...(ownerEnvsDir === undefined ? {} : { ownerEnvsDir }),
  };
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}
