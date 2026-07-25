import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { CondaInfo } from './parsers';
import {
  condaExecutableCandidatePaths,
  isCondaExecutable,
  isRunnableCondaExecutable,
  resolveCondaExecutablePath,
} from './executable';
import {
  canonicalCondaPath,
  condaInstallationRootFromExecutable,
  findCondaExecutable,
  inspectCondaPrefix,
  isCondaInstallationRoot,
  type CondaPrefixMetadata,
} from './prefixes';
import { canonicalEnvironmentPath, normalizeEnvironmentPath } from './workspaceRouting';

export interface CondaDiscoveryOptions {
  readonly condaExecutable?: string;
  readonly additionalPrefixes?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly userHome?: string;
  readonly standardRoots?: readonly string[];
  readonly includeGlobalSources?: boolean;
}

export interface CondaDiscoveryResult {
  readonly info: CondaInfo;
  readonly primaryRootResolved: boolean;
  readonly metadata: readonly CondaPrefixMetadata[];
  readonly watchPaths: readonly string[];
}

interface Installation {
  readonly root: string;
  readonly identity: string;
  executable?: string;
}

interface EnvironmentDirectory {
  readonly path: string;
  readonly identity: string;
  ownerRoot?: string;
  ownerRootIdentity?: string;
}

interface PrimaryRoot {
  readonly root: string;
  readonly resolved: boolean;
}

class DiscoveryPaths {
  private readonly values = new Set<string>();

  add(value: string | null | undefined): void {
    if (value !== undefined && value !== null && value.trim() !== '') {
      this.values.add(path.normalize(path.resolve(value)));
    }
  }

  addPrefix(prefix: string | null | undefined): void {
    if (prefix === undefined || prefix === null || prefix.trim() === '') {
      return;
    }
    this.add(prefix);
    this.add(path.join(prefix, 'conda-meta'));
    this.add(path.join(prefix, 'conda-meta', 'history'));
  }

  entries(): readonly string[] {
    return [...this.values];
  }
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

function pathValue(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.PATH ?? environment.Path ?? environment.path;
}

function splitEnvironmentPaths(value: string | undefined): readonly string[] {
  return value === undefined || value.trim() === ''
    ? []
    : value
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter(Boolean);
}

function hostCondaPlatform(): string {
  const architecture =
    process.arch === 'arm64'
      ? 'arm64'
      : process.arch === 'x64'
        ? '64'
        : process.arch === 'ia32'
          ? '32'
          : process.arch;
  if (process.platform === 'darwin') {
    return `osx-${architecture}`;
  }
  if (process.platform === 'win32') {
    return `win-${architecture}`;
  }
  return `linux-${architecture === 'arm64' ? 'aarch64' : architecture}`;
}

function defaultRuntimeRoot(environment: NodeJS.ProcessEnv, userHome: string): string {
  if (process.platform === 'win32') {
    return path.join(
      environment.LOCALAPPDATA ?? path.join(userHome, 'AppData', 'Local'),
      'conda',
      'runtime',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(userHome, 'Library', 'Application Support', 'conda', 'runtime');
  }
  return path.join(
    environment.XDG_DATA_HOME ?? path.join(userHome, '.local', 'share'),
    'conda',
    'runtime',
  );
}

export function standardCondaRoots(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): readonly string[] {
  if (process.platform === 'win32') {
    const local = environment.LOCALAPPDATA;
    const programData = environment.PROGRAMDATA;
    return [
      ...['anaconda3', 'miniconda3', 'miniforge3'].map((name) => path.join(userHome, name)),
      ...(local === undefined
        ? []
        : ['Anaconda3', 'Miniconda3', 'Miniforge3'].map((name) => path.join(local, name))),
      ...(programData === undefined
        ? []
        : ['Anaconda3', 'Miniconda3', 'Miniforge3'].map((name) => path.join(programData, name))),
    ];
  }

  const installationNames = ['anaconda', 'anaconda3', 'miniconda', 'miniconda3', 'miniforge3'];
  const prefixes = [
    '/',
    userHome,
    path.join(userHome, 'opt'),
    path.join(userHome, '.conda'),
    path.join(userHome, '.local'),
    '/opt',
    '/usr/share',
    '/usr/local',
    '/usr',
    ...(process.platform === 'darwin' ? ['/opt/homebrew'] : ['/home/linuxbrew/.linuxbrew']),
  ];
  return [
    ...prefixes.flatMap((prefix) => installationNames.map((name) => path.join(prefix, name))),
    ...['.anaconda', '.miniconda3', '.miniforge3', '.cx'].map((name) => path.join(userHome, name)),
    '/miniforge',
    '/opt/conda',
    '/opt/homebrew/Caskroom/miniconda/base',
    '/opt/homebrew/Caskroom/miniforge/base',
    '/usr/local/Caskroom/miniconda/base',
    '/usr/local/Caskroom/miniforge/base',
  ];
}

async function isFile(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isFile();
  } catch {
    return false;
  }
}

async function executablesOnPath(
  environment: NodeJS.ProcessEnv,
  paths: DiscoveryPaths,
): Promise<readonly string[]> {
  const value = pathValue(environment);
  if (value === undefined || value.trim() === '') {
    return [];
  }

  const names = process.platform === 'win32' ? ['conda.exe', 'conda.bat'] : ['conda'];
  const executables: string[] = [];
  for (const directory of value.split(path.delimiter).filter((item) => item.trim() !== '')) {
    paths.add(directory);
    for (const name of names) {
      const candidate = path.join(directory, name);
      paths.add(candidate);
      if (await isFile(candidate)) {
        executables.push(await canonicalCondaPath(candidate));
      }
    }
  }
  return executables;
}

async function registryPrefixes(
  userHome: string,
  paths: DiscoveryPaths,
): Promise<readonly string[]> {
  const registry = path.join(userHome, '.conda', 'environments.txt');
  paths.add(registry);
  try {
    const contents = await readFile(registry, 'utf8');
    return contents
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item !== '' && !item.startsWith('#'))
      .map((item) => expandUser(item, userHome));
  } catch {
    return [];
  }
}

async function installationForPrefix(prefix: string): Promise<string | undefined> {
  if (await isCondaInstallationRoot(prefix)) {
    return canonicalCondaPath(prefix);
  }
  if (path.basename(path.dirname(prefix)).toLowerCase() !== 'envs') {
    return undefined;
  }
  const candidate = path.dirname(path.dirname(prefix));
  return (await isCondaInstallationRoot(candidate)) ? canonicalCondaPath(candidate) : undefined;
}

async function primaryRoot(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv,
  userHome: string,
  registry: readonly string[],
  paths: DiscoveryPaths,
): Promise<PrimaryRoot> {
  for (const candidate of condaExecutableCandidatePaths(executable, environment)) {
    paths.add(candidate);
  }
  const resolvedExecutable = await resolveCondaExecutablePath(executable, environment);
  paths.add(resolvedExecutable);
  if (resolvedExecutable !== undefined && isCondaExecutable(resolvedExecutable)) {
    const root = condaInstallationRootFromExecutable(resolvedExecutable);
    paths.addPrefix(root);
    if (root !== undefined && (await isCondaInstallationRoot(root))) {
      return { root: await canonicalCondaPath(root), resolved: true };
    }
  }

  const configuredRoot = environment.CONDA_ROOT_PREFIX?.trim();
  if (configuredRoot) {
    paths.addPrefix(configuredRoot);
    const root = await canonicalCondaPath(configuredRoot);
    if (await isCondaInstallationRoot(root)) {
      return { root, resolved: true };
    }
  }

  const activePrefix = environment.CONDA_PREFIX?.trim();
  if (activePrefix) {
    paths.addPrefix(activePrefix);
    const root = await installationForPrefix(activePrefix);
    if (root !== undefined) {
      return { root, resolved: true };
    }
  }

  const runtime = defaultRuntimeRoot(environment, userHome);
  paths.addPrefix(runtime);
  if (await isCondaInstallationRoot(runtime)) {
    return { root: await canonicalCondaPath(runtime), resolved: true };
  }

  for (const prefix of registry) {
    paths.addPrefix(prefix);
    const root = await installationForPrefix(prefix);
    if (root !== undefined) {
      return { root, resolved: true };
    }
  }
  return { root: path.normalize(path.resolve(runtime)), resolved: false };
}

async function discoveryInfo(
  cached: CondaInfo | undefined,
  options: CondaDiscoveryOptions,
  environment: NodeJS.ProcessEnv,
  userHome: string,
  registry: readonly string[],
  paths: DiscoveryPaths,
): Promise<{ readonly info: CondaInfo; readonly primaryRootResolved: boolean }> {
  if (cached !== undefined && options.condaExecutable === undefined) {
    return { info: cached, primaryRootResolved: true };
  }
  const activePrefix = environment.CONDA_PREFIX?.trim() || null;
  const primary = await primaryRoot(
    options.condaExecutable,
    environment,
    userHome,
    registry,
    paths,
  );
  const rootPrefix = primary.root;
  const seed: CondaInfo = {
    platform: hostCondaPlatform(),
    rootPrefix,
    envsDirs: [
      ...new Set(
        [
          ...splitEnvironmentPaths(environment.CONDA_ENVS_PATH),
          ...splitEnvironmentPaths(environment.CONDA_ENVS_DIRS),
          path.join(userHome, '.conda', 'envs'),
          path.join(rootPrefix, 'envs'),
        ].map((item) => path.normalize(path.resolve(item))),
      ),
    ],
    defaultPrefix: activePrefix ?? rootPrefix,
    activePrefix,
    envs: [
      ...new Set(
        [
          rootPrefix,
          ...(options.includeGlobalSources === false ? [] : registry),
          ...(activePrefix === null ? [] : [activePrefix]),
        ].map((item) => path.normalize(path.resolve(item))),
      ),
    ],
    envsDetails: {},
  };
  if (cached === undefined || (primary.resolved && !samePath(seed.rootPrefix, cached.rootPrefix))) {
    return { info: seed, primaryRootResolved: primary.resolved };
  }
  const sameRoot = samePath(seed.rootPrefix, cached.rootPrefix);
  const merged = {
    ...cached,
    ...(sameRoot
      ? {
          rootPrefix: primary.resolved ? seed.rootPrefix : cached.rootPrefix,
          envsDirs: [...new Set([...cached.envsDirs, ...seed.envsDirs])],
        }
      : {}),
    defaultPrefix: seed.activePrefix ?? cached.defaultPrefix,
    activePrefix: seed.activePrefix,
    envs: [...new Set([...cached.envs, ...seed.envs])],
  };
  return { info: merged, primaryRootResolved: true };
}

function samePath(left: string, right: string): boolean {
  return canonicalEnvironmentPath(left) === canonicalEnvironmentPath(right);
}

function environmentPrefixes(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(environment).flatMap(([name, value]) =>
    value !== undefined && /^CONDA_PREFIX(?:_\d+)?$/i.test(name) && value.trim() !== ''
      ? [value]
      : [],
  );
}

function environmentDirectories(environment: NodeJS.ProcessEnv): readonly string[] {
  const value = environment.CONDA_ENVS_PATH?.trim();
  return value === undefined || value === '' ? [] : value.split(path.delimiter);
}

function environmentRoots(environment: NodeJS.ProcessEnv): readonly string[] {
  return [environment.CONDA_ROOT_PREFIX].filter(
    (value): value is string => value !== undefined && value.trim() !== '',
  );
}

function environmentExecutables(environment: NodeJS.ProcessEnv): readonly string[] {
  return [environment.CONDA_EXE].filter(
    (value): value is string =>
      value !== undefined && value.trim() !== '' && isCondaExecutable(value),
  );
}

export async function discoverCondaPrefixes(
  cachedInfo: CondaInfo | undefined,
  options: CondaDiscoveryOptions = {},
): Promise<CondaDiscoveryResult> {
  const environment = options.environment ?? process.env;
  const userHome = options.userHome ?? homedir();
  const includeGlobalSources = options.includeGlobalSources ?? true;
  const watchPaths = new DiscoveryPaths();
  const registry = await registryPrefixes(userHome, watchPaths);
  const { info, primaryRootResolved } = await discoveryInfo(
    cachedInfo,
    options,
    environment,
    userHome,
    registry,
    watchPaths,
  );
  const installations = new Map<string, Installation>();
  const environmentDirectoriesByPath = new Map<string, EnvironmentDirectory>();
  const environmentDirectoryQueue: EnvironmentDirectory[] = [];
  const candidatePrefixes = new Map<string, string>();
  const candidateQueue: string[] = [];
  const metadataByPrefix = new Map<string, CondaPrefixMetadata>();
  const inspectionContextByPrefix = new Map<string, string>();

  const addCandidate = async (value: string): Promise<void> => {
    if (value.trim() === '') {
      return;
    }
    const candidate = path.normalize(path.resolve(expandUser(value, userHome)));
    watchPaths.addPrefix(candidate);
    const key = normalizeEnvironmentPath(await canonicalCondaPath(candidate));
    if (!candidatePrefixes.has(key)) {
      candidatePrefixes.set(key, candidate);
      candidateQueue.push(candidate);
    }
  };

  const addEnvironmentDirectory = async (value: string, ownerRoot?: string): Promise<void> => {
    if (value.trim() === '') {
      return;
    }
    const directory = path.normalize(path.resolve(expandUser(value, userHome)));
    watchPaths.add(directory);
    const identity = await canonicalCondaPath(directory);
    const key = normalizeEnvironmentPath(identity);
    const ownerRootIdentity =
      ownerRoot === undefined ? undefined : await canonicalCondaPath(ownerRoot);
    const existing = environmentDirectoriesByPath.get(key);
    if (existing === undefined) {
      const entry = {
        path: directory,
        identity,
        ...(ownerRoot === undefined ? {} : { ownerRoot }),
        ...(ownerRootIdentity === undefined ? {} : { ownerRootIdentity }),
      };
      environmentDirectoriesByPath.set(key, entry);
      environmentDirectoryQueue.push(entry);
    } else if (existing.ownerRoot === undefined && ownerRoot !== undefined) {
      existing.ownerRoot = ownerRoot;
      existing.ownerRootIdentity = ownerRootIdentity;
    }
  };

  const addInstallation = async (
    value: string,
    executable?: string,
    trusted = false,
  ): Promise<void> => {
    if (value.trim() === '') {
      return;
    }
    const root = path.normalize(path.resolve(expandUser(value, userHome)));
    watchPaths.addPrefix(root);
    watchPaths.add(path.join(root, 'envs'));
    watchPaths.add(executable);
    const rootIdentity = await canonicalCondaPath(root);
    const parentEnvironmentRoot =
      path.basename(path.dirname(root)).toLowerCase() === 'envs'
        ? path.dirname(path.dirname(root))
        : undefined;
    if (
      !trusted &&
      parentEnvironmentRoot !== undefined &&
      (await isCondaInstallationRoot(parentEnvironmentRoot))
    ) {
      return;
    }
    if (!trusted && !(await isCondaInstallationRoot(root))) {
      return;
    }
    const key = normalizeEnvironmentPath(rootIdentity);
    const existing = installations.get(key);
    const safeExecutable =
      executable === undefined || !isRunnableCondaExecutable(executable) ? undefined : executable;
    const executableCandidate =
      safeExecutable === undefined || safeExecutable.trim() === ''
        ? await findCondaExecutable(root)
        : safeExecutable;
    const resolvedExecutable =
      executableCandidate === undefined || !path.isAbsolute(executableCandidate)
        ? executableCandidate
        : await canonicalCondaPath(executableCandidate);
    if (existing === undefined) {
      installations.set(key, {
        root,
        identity: rootIdentity,
        ...(resolvedExecutable === undefined ? {} : { executable: resolvedExecutable }),
      });
      await addCandidate(root);
      await addEnvironmentDirectory(path.join(root, 'envs'), root);
      return;
    }
    if (existing.executable === undefined && resolvedExecutable !== undefined) {
      existing.executable = resolvedExecutable;
    }
  };

  const primaryRoot = path.normalize(path.resolve(expandUser(info.rootPrefix, userHome)));
  await addInstallation(primaryRoot, options.condaExecutable, primaryRootResolved);
  for (const directory of info.envsDirs) {
    await addEnvironmentDirectory(directory, primaryRoot);
  }
  for (const prefix of [
    info.rootPrefix,
    ...info.envs,
    info.defaultPrefix,
    ...(info.activePrefix === null ? [] : [info.activePrefix]),
    ...(options.additionalPrefixes ?? []),
  ]) {
    await addCandidate(prefix);
  }

  if (includeGlobalSources) {
    for (const prefix of [...environmentPrefixes(environment), ...registry]) {
      await addCandidate(prefix);
    }
    for (const directory of environmentDirectories(environment)) {
      await addEnvironmentDirectory(directory);
    }
    for (const root of [
      ...environmentRoots(environment),
      ...(options.standardRoots ?? standardCondaRoots(environment, userHome)),
    ]) {
      await addInstallation(root);
    }
    for (const executable of [
      ...(options.condaExecutable === undefined ? [] : [options.condaExecutable]),
      ...environmentExecutables(environment),
      ...(await executablesOnPath(environment, watchPaths)),
    ]) {
      const root = condaInstallationRootFromExecutable(executable);
      if (root !== undefined) {
        await addInstallation(root, executable);
      }
    }
    const condaPython = environment.CONDA_PYTHON_EXE?.trim();
    if (condaPython) {
      const root = condaInstallationRootFromExecutable(condaPython);
      if (root !== undefined) {
        await addInstallation(root);
      }
    }
  }

  const ownerEnvironmentDirectories = (owner: Installation): readonly EnvironmentDirectory[] => {
    const ownerIdentity = normalizeEnvironmentPath(owner.identity);
    return [...environmentDirectoriesByPath.values()].filter(
      (directory) =>
        directory.ownerRootIdentity !== undefined &&
        normalizeEnvironmentPath(directory.ownerRootIdentity) === ownerIdentity,
    );
  };

  const inspectionContext = async (
    candidate: string,
  ): Promise<{
    readonly candidateKey: string;
    readonly owner?: Installation;
    readonly ownerEnvsDirs: readonly string[];
    readonly fingerprint: string;
  }> => {
    const candidateIdentity = await canonicalCondaPath(candidate);
    const candidateKey = normalizeEnvironmentPath(candidateIdentity);
    const parentDirectory = environmentDirectoriesByPath.get(
      normalizeEnvironmentPath(path.dirname(candidateIdentity)),
    );
    const exactInstallation = installations.get(candidateKey);
    const ownerKey =
      exactInstallation === undefined
        ? parentDirectory?.ownerRootIdentity === undefined
          ? undefined
          : normalizeEnvironmentPath(parentDirectory.ownerRootIdentity)
        : candidateKey;
    const owner = ownerKey === undefined ? undefined : installations.get(ownerKey);
    const ownerDirectories = owner === undefined ? [] : ownerEnvironmentDirectories(owner);
    return {
      candidateKey,
      ...(owner === undefined ? {} : { owner }),
      ownerEnvsDirs: ownerDirectories.map((directory) => directory.path),
      fingerprint: JSON.stringify([
        ownerKey,
        owner?.executable,
        ownerDirectories.map((directory) => normalizeEnvironmentPath(directory.identity)).sort(),
      ]),
    };
  };

  const inspectCandidate = (
    candidate: string,
    context: Awaited<ReturnType<typeof inspectionContext>>,
  ): Promise<CondaPrefixMetadata | undefined> => {
    const owner = context.owner;
    return inspectCondaPrefix(candidate, info, {
      ...(owner === undefined ? {} : { ownerRoot: owner.root }),
      ...(owner?.executable === undefined ? {} : { ownerExecutable: owner.executable }),
      ...(owner === undefined ? {} : { ownerEnvsDirs: context.ownerEnvsDirs }),
      primaryRootTrusted: primaryRootResolved,
    });
  };

  let directoryIndex = 0;
  let candidateIndex = 0;
  while (
    directoryIndex < environmentDirectoryQueue.length ||
    candidateIndex < candidateQueue.length
  ) {
    while (directoryIndex < environmentDirectoryQueue.length) {
      const directory = environmentDirectoryQueue[directoryIndex];
      directoryIndex += 1;
      if (directory === undefined) {
        continue;
      }
      try {
        const entries = await readdir(directory.path, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            await addCandidate(path.join(directory.path, entry.name));
          }
        }
      } catch {
        // Missing or unreadable environment directories do not stop discovery.
      }
    }

    while (candidateIndex < candidateQueue.length) {
      const candidate = candidateQueue[candidateIndex];
      candidateIndex += 1;
      if (candidate === undefined) {
        continue;
      }
      const context = await inspectionContext(candidate);
      const metadata = await inspectCandidate(candidate, context);
      if (metadata === undefined) {
        continue;
      }
      metadataByPrefix.set(context.candidateKey, metadata);
      inspectionContextByPrefix.set(context.candidateKey, context.fingerprint);
      if (metadata.condaInstallation) {
        await addInstallation(metadata.prefix, metadata.ownerExecutable, true);
      } else if (metadata.ownerRoot !== undefined) {
        await addInstallation(metadata.ownerRoot, metadata.ownerExecutable);
      }
    }
  }

  const discovered: CondaPrefixMetadata[] = [];
  for (const candidate of candidatePrefixes.values()) {
    const context = await inspectionContext(candidate);
    const initial = metadataByPrefix.get(context.candidateKey);
    if (initial === undefined) {
      continue;
    }
    const metadata =
      inspectionContextByPrefix.get(context.candidateKey) === context.fingerprint
        ? initial
        : await inspectCandidate(candidate, context);
    if (metadata !== undefined) {
      watchPaths.addPrefix(metadata.prefix);
      watchPaths.add(metadata.pythonPath);
      watchPaths.addPrefix(metadata.ownerRoot);
      watchPaths.add(metadata.ownerExecutable);
      watchPaths.add(metadata.ownerEnvsDir);
      discovered.push(metadata);
    }
  }
  return {
    info,
    primaryRootResolved,
    metadata: discovered.sort((left, right) => left.prefix.localeCompare(right.prefix)),
    watchPaths: watchPaths.entries(),
  };
}
