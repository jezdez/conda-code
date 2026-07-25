import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  EnvironmentManager,
  Package,
  PackageInfo,
  PackageManager,
  PythonEnvironment,
  PythonEnvironmentApi,
  PythonEnvironmentInfo,
} from '@vscode/python-environments';
import type { Memento, Uri as VscodeUri } from 'vscode';

import type { CondaClient } from './conda';
import type { CondaInfo } from './parsers';
import { canonicalCondaPath } from './prefixes';
import type { CondaWorkspaceRouteManager } from './workspaceRouting';
import type { CondaWorkspacesClient, InstalledWorkspaceEnvironment } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-test:vscode';
const VSCODE_STUB_SOURCE = String.raw`
const path = require('node:path');

class Uri {
  constructor(scheme, fsPath) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }
  static file(value) {
    return new Uri('file', path.resolve(value));
  }
  static parse(value) {
    const separator = value.indexOf(':');
    const scheme = separator < 0 ? '' : value.slice(0, separator);
    const encodedPath = separator < 0 ? value : value.slice(separator + 1);
    return new Uri(scheme, decodeURIComponent(encodedPath));
  }
  toString() {
    return this.scheme + ':' + encodeURIComponent(this.fsPath);
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

class Disposable {
  constructor(callOnDispose) {
    this.callOnDispose = callOnDispose;
  }
  dispose() {
    this.callOnDispose();
  }
}

const __state = { files: [], folders: [] };
const workspace = {
  findFiles: async (pattern) =>
    __state.files.filter((uri) => pattern.includes(path.basename(uri.fsPath))),
  getWorkspaceFolder: (uri) =>
    __state.folders
      .filter((folder) => {
        const relative = path.relative(folder.uri.fsPath, uri.fsPath);
        return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..');
      })
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0],
};

const window = {
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
};

module.exports = { __state, Disposable, EventEmitter, ThemeIcon, Uri, window, workspace };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
      return { url: VSCODE_STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === VSCODE_STUB_URL) {
      return {
        format: 'commonjs',
        source: VSCODE_STUB_SOURCE,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const requireFromTest = createRequire(__filename);

interface VscodeStub {
  readonly Uri: {
    file(value: string): VscodeUri;
  };
  readonly __state: {
    files: VscodeUri[];
    folders: { readonly uri: VscodeUri }[];
  };
}

function memory(): Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string, defaultValue?: unknown) =>
      values.has(key) ? values.get(key) : defaultValue,
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  } as Memento;
}

function condaInfo(
  rootPrefix: string,
  envs: readonly string[] = [],
  envsDir = path.join(rootPrefix, 'envs'),
): CondaInfo {
  return {
    platform: 'linux-64',
    rootPrefix,
    envsDirs: [envsDir],
    defaultPrefix: rootPrefix,
    activePrefix: null,
    envs,
    envsDetails: {},
  };
}

async function createCondaInstallation(root: string): Promise<string> {
  const executable = path.join(
    root,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'conda.exe' : 'conda',
  );
  await Promise.all([
    mkdir(path.join(root, 'conda-meta'), { recursive: true }),
    mkdir(path.join(root, 'envs'), { recursive: true }),
    mkdir(path.join(root, 'pkgs'), { recursive: true }),
    mkdir(path.dirname(executable), { recursive: true }),
  ]);
  await writeFile(executable, '');
  return executable;
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function pythonApi(projects: readonly VscodeUri[]): PythonEnvironmentApi {
  let nextId = 1;
  const pythonProjects = projects.map((uri) => ({
    name: path.basename(uri.fsPath),
    uri,
  }));
  return {
    createPythonEnvironmentItem: (
      info: PythonEnvironmentInfo,
      manager: EnvironmentManager,
    ): PythonEnvironment => ({
      ...info,
      envId: {
        id: `${info.environmentPath.toString(true)}:${nextId++}`,
        managerId: manager.preferredPackageManagerId,
      },
    }),
    createPackageItem: (
      info: PackageInfo,
      environment: PythonEnvironment,
      manager: PackageManager,
    ): Package => ({
      ...info,
      pkgId: {
        id: info.name,
        managerId: manager.name,
        environmentId: environment.envId.id,
      },
    }),
    getPythonProjects: () => pythonProjects,
    getPythonProject: (scope: VscodeUri) =>
      pythonProjects
        .filter((project) => containsPath(project.uri.fsPath, scope.fsPath))
        .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0],
  } as unknown as PythonEnvironmentApi;
}

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const environmentManager = requireFromTest(
    './environmentManager.js',
  ) as typeof import('./environmentManager.js');
  const packageManager = requireFromTest(
    './packageManager.js',
  ) as typeof import('./packageManager.js');
  const { CondaSelectionState } = requireFromTest(
    './selectionState.js',
  ) as typeof import('./selectionState.js');
  return { vscode, environmentManager, packageManager, CondaSelectionState };
}

test('resolve inspects and retains an unknown conda prefix from its Python executable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'unregistered');
  const python = path.join(prefix, 'bin', 'python');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h1_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
  );
  await writeFile(python, '');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const info = condaInfo(path.join(root, 'base'));
  const conda = {
    getInfo: async () => info,
  } as unknown as CondaClient;
  const workspaces = {} as CondaWorkspacesClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const resolved = await manager.resolve(vscode.Uri.file(python));
  assert.equal(resolved?.environmentPath.fsPath, prefix);
  assert.equal(resolved?.execInfo.run.executable, python);

  await manager.refresh(undefined);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === prefix,
    ),
    true,
  );
});

test('configured conda discovery does not call conda info', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-process-free-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  let getInfoCalls = 0;
  const conda = {
    executable,
    getInfo: async () => {
      getInfoCalls += 1;
      throw new Error('conda info must not run during regular discovery');
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );
  t.after(() => manager.dispose());

  assert.deepEqual(
    (await manager.getEnvironments('all')).map(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath,
    ),
    [await canonicalCondaPath(installation)],
  );
  assert.equal(getInfoCalls, 0);
});

test('configured conda discovery discards cached information for a different root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-stale-info-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const previousInstallation = path.join(root, 'previous');
  const previousNamed = path.join(previousInstallation, 'envs', 'stale');
  const currentInstallation = path.join(root, 'current');
  await createCondaInstallation(previousInstallation);
  const executable = await createCondaInstallation(currentInstallation);
  await mkdir(path.join(previousNamed, 'conda-meta'), { recursive: true });

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  let getInfoCalls = 0;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        getInfoCalls += 1;
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      initialCondaInfo: condaInfo(previousInstallation, [previousNamed]),
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );
  t.after(() => manager.dispose());

  assert.deepEqual(
    (await manager.getEnvironments('all')).map(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath,
    ),
    [await canonicalCondaPath(currentInstallation)],
  );
  assert.equal(getInfoCalls, 0);
});

test('conda info enrichment is nonblocking, coalesced, and reusable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-enrichment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  let resolveEnrichment!: (info: CondaInfo | undefined) => void;
  const enrichment = new Promise<CondaInfo | undefined>((resolve) => {
    resolveEnrichment = resolve;
  });
  let enrichmentCalls = 0;
  const enrichmentForces: boolean[] = [];

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const conda = {
    executable,
    getInfo: async () => {
      throw new Error('regular discovery must not call conda info');
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: ({ force }) => {
        enrichmentCalls += 1;
        enrichmentForces.push(force);
        return enrichment;
      },
    },
  );
  t.after(() => manager.dispose());

  const environments = await manager.getEnvironments('all');
  assert.deepEqual(
    environments.map((environment: PythonEnvironment) => environment.environmentPath.fsPath),
    [await canonicalCondaPath(installation)],
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls, 1);
  assert.deepEqual(enrichmentForces, [false]);

  await Promise.all([manager.refresh(undefined), manager.refresh(undefined)]);
  assert.equal(enrichmentCalls, 1);

  resolveEnrichment(undefined);
  await enrichment;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await manager.refresh(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls, 2);
  assert.deepEqual(enrichmentForces, [false, false]);
});

test('forced conda info enrichment discards stale work and coalesces follow-ups', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-forced-enrichment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const staleEnvsDir = path.join(root, 'stale-envs');
  const stalePrefix = path.join(staleEnvsDir, 'stale');
  const winningEnvsDir = path.join(root, 'winning-envs');
  const winningPrefix = path.join(winningEnvsDir, 'winner');
  await Promise.all([
    mkdir(path.join(stalePrefix, 'conda-meta'), { recursive: true }),
    mkdir(path.join(winningPrefix, 'conda-meta'), { recursive: true }),
  ]);
  const staleInfo = condaInfo(installation, [stalePrefix], staleEnvsDir);
  const winningInfo = condaInfo(installation, [winningPrefix], winningEnvsDir);
  const enrichmentCalls: {
    readonly force: boolean;
    readonly signal: AbortSignal;
    readonly resolve: (info: CondaInfo | undefined) => void;
  }[] = [];
  const saved: CondaInfo[] = [];

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: ({ force, signal }) =>
        new Promise<CondaInfo | undefined>((resolve) => {
          enrichmentCalls.push({ force, signal, resolve });
        }),
      saveCondaInfo: (info) => {
        if (info !== undefined) {
          saved.push(info);
        }
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 1);
  assert.equal(enrichmentCalls[0]?.force, false);

  manager.invalidateCondaInfo();
  manager.invalidateCondaInfo();
  manager.invalidateCondaInfo();
  assert.equal(enrichmentCalls.length, 1);
  assert.equal(enrichmentCalls[0]?.signal.aborted, true);

  enrichmentCalls[0]?.resolve(staleInfo);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 2);
  assert.equal(enrichmentCalls[1]?.force, true);
  assert.equal(enrichmentCalls[1]?.signal.aborted, false);
  assert.deepEqual(saved, []);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === stalePrefix,
    ),
    false,
  );

  const changed = new Promise<void>((resolve) => {
    const listener = manager.onDidChangeEnvironments(() => {
      listener.dispose();
      resolve();
    });
  });
  enrichmentCalls[1]?.resolve(winningInfo);
  await changed;

  assert.deepEqual(saved, [winningInfo]);
  const environments = await manager.getEnvironments('all');
  assert.equal(
    environments.some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === stalePrefix,
    ),
    false,
  );
  assert.equal(
    environments.some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === winningPrefix,
    ),
    true,
  );
  assert.equal(enrichmentCalls.length, 2);
});

test('enrichment that wins during refresh is not overwritten by the old snapshot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-enrichment-refresh-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  const customEnvsDir = path.join(root, 'custom-envs');
  const customPrefix = path.join(customEnvsDir, 'winner');
  await Promise.all([
    mkdir(projectPath),
    mkdir(path.join(customPrefix, 'conda-meta'), { recursive: true }),
  ]);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');
  const enrichedInfo = condaInfo(installation, [customPrefix], customEnvsDir);
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let workspaceCalls = 0;
  const workspaces = {
    getWorkspaceInfo: async () => {
      workspaceCalls += 1;
      if (workspaceCalls === 2) {
        refreshStarted();
        await refreshGate;
      }
      return { manifest: manifestPath, name: 'demo' };
    },
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;
  let resolveEnrichment!: (info: CondaInfo | undefined) => void;
  const enrichment = new Promise<CondaInfo | undefined>((resolve) => {
    resolveEnrichment = resolve;
  });
  let enrichmentSaved!: () => void;
  const saved = new Promise<void>((resolve) => {
    enrichmentSaved = resolve;
  });

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      initialCondaInfo: condaInfo(installation),
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: () => enrichment,
      saveCondaInfo: (info) => {
        if (info === enrichedInfo) {
          enrichmentSaved();
        }
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const refresh = manager.refresh(undefined);
  await started;
  resolveEnrichment(enrichedInfo);
  await saved;
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseRefresh();
  await refresh;

  assert.ok(workspaceCalls >= 3);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === customPrefix,
    ),
    true,
  );
});

test('invalidation during persistence does not commit superseded conda information', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-persisting-enrichment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const staleEnvsDir = path.join(root, 'stale-envs');
  const stalePrefix = path.join(staleEnvsDir, 'stale');
  const winningEnvsDir = path.join(root, 'winning-envs');
  const winningPrefix = path.join(winningEnvsDir, 'winner');
  await Promise.all([
    mkdir(path.join(stalePrefix, 'conda-meta'), { recursive: true }),
    mkdir(path.join(winningPrefix, 'conda-meta'), { recursive: true }),
  ]);
  const enrichmentCalls: {
    readonly resolve: (info: CondaInfo | undefined) => void;
  }[] = [];
  let persistenceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    persistenceStarted = resolve;
  });
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let saveCalls = 0;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: () =>
        new Promise<CondaInfo | undefined>((resolve) => {
          enrichmentCalls.push({ resolve });
        }),
      saveCondaInfo: async () => {
        saveCalls += 1;
        if (saveCalls === 1) {
          persistenceStarted();
          await persistenceGate;
        }
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  enrichmentCalls[0]?.resolve(condaInfo(installation, [stalePrefix], staleEnvsDir));
  await started;
  manager.invalidateCondaInfo();
  releasePersistence();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 2);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === stalePrefix,
    ),
    false,
  );

  const changed = new Promise<void>((resolve) => {
    const listener = manager.onDidChangeEnvironments(() => {
      listener.dispose();
      resolve();
    });
  });
  enrichmentCalls[1]?.resolve(condaInfo(installation, [winningPrefix], winningEnvsDir));
  await changed;
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === winningPrefix,
    ),
    true,
  );
});

test('disposing prevents forced conda info enrichment retries and saves', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-disposed-enrichment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const info = condaInfo(installation);
  const enrichmentCalls: {
    readonly force: boolean;
    readonly signal: AbortSignal;
    readonly resolve: (info: CondaInfo | undefined) => void;
  }[] = [];
  const saved: CondaInfo[] = [];

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: ({ force, signal }) =>
        new Promise<CondaInfo | undefined>((resolve) => {
          enrichmentCalls.push({ force, signal, resolve });
        }),
      saveCondaInfo: (value) => {
        if (value !== undefined) {
          saved.push(value);
        }
      },
    },
  );

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 1);
  enrichmentCalls[0]?.resolve(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  manager.invalidateCondaInfo();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 2);
  assert.equal(enrichmentCalls[1]?.force, true);

  manager.invalidateCondaInfo();
  manager.invalidateCondaInfo();
  manager.dispose();
  assert.equal(enrichmentCalls[1]?.signal.aborted, true);
  enrichmentCalls[1]?.resolve(info);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(enrichmentCalls.length, 2);
  assert.deepEqual(saved, []);
  manager.invalidateCondaInfo();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 2);
});

test('failed conda info persistence does not block enriched discovery', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-enrichment-save-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const customEnvsDir = path.join(root, 'custom-envs');
  const customPrefix = path.join(customEnvsDir, 'custom');
  await mkdir(path.join(customPrefix, 'conda-meta'), { recursive: true });
  const enrichedInfo = condaInfo(installation, [customPrefix], customEnvsDir);
  let resolveEnrichment!: (info: CondaInfo | undefined) => void;
  const enrichment = new Promise<CondaInfo | undefined>((resolve) => {
    resolveEnrichment = resolve;
  });
  let saveCalls = 0;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: () => enrichment,
      saveCondaInfo: () => {
        saveCalls += 1;
        throw new Error('storage unavailable');
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  const changed = new Promise<void>((resolve) => {
    const listener = manager.onDidChangeEnvironments(() => {
      listener.dispose();
      resolve();
    });
  });
  resolveEnrichment(enrichedInfo);
  await changed;

  assert.equal(saveCalls, 1);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === customPrefix,
    ),
    true,
  );
});

test('refresh requests during a follow-up trigger another pass', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-refresh-coalescing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  await mkdir(projectPath);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');

  let startFirstRefresh!: () => void;
  const firstRefreshStarted = new Promise<void>((resolve) => {
    startFirstRefresh = resolve;
  });
  let releaseFirstRefresh!: () => void;
  const firstRefreshGate = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });
  let startSecondRefresh!: () => void;
  const secondRefreshStarted = new Promise<void>((resolve) => {
    startSecondRefresh = resolve;
  });
  let releaseSecondRefresh!: () => void;
  const secondRefreshGate = new Promise<void>((resolve) => {
    releaseSecondRefresh = resolve;
  });
  let workspaceDiscoveryCalls = 0;
  const workspaces = {
    getWorkspaceInfo: async () => {
      workspaceDiscoveryCalls += 1;
      if (workspaceDiscoveryCalls === 1) {
        startFirstRefresh();
        await firstRefreshGate;
      } else if (workspaceDiscoveryCalls === 2) {
        startSecondRefresh();
        await secondRefreshGate;
      }
      return { manifest: manifestPath, name: 'demo' };
    },
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const conda = {
    executable,
    getInfo: async () => {
      throw new Error('regular discovery must not call conda info');
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );
  t.after(() => manager.dispose());

  const first = manager.refresh(undefined);
  await firstRefreshStarted;
  const coalesced = Array.from({ length: 8 }, () => manager.refresh(undefined));
  assert.equal(new Set([first, ...coalesced]).size, 1);
  releaseFirstRefresh();
  await secondRefreshStarted;
  const duringFollowUp = manager.refresh(undefined);
  assert.equal(duringFollowUp, first);
  releaseSecondRefresh();
  await Promise.all([first, ...coalesced, duringFollowUp]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(workspaceDiscoveryCalls, 3);
});

test('a request queued during a failed refresh still gets a follow-up pass', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-refresh-failure-follow-up-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  let firstEntriesStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstEntriesStarted = resolve;
  });
  let releaseFirstEntries!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirstEntries = resolve;
  });
  let entryCalls = 0;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const selectionState = new CondaSelectionState(memory());
  selectionState.entries = async () => {
    entryCalls += 1;
    if (entryCalls === 1) {
      firstEntriesStarted();
      await gate;
      throw new Error('first refresh failed');
    }
    return {};
  };
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    selectionState,
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );
  t.after(() => manager.dispose());

  const first = manager.refresh(undefined);
  await started;
  const followUp = manager.refresh(undefined);
  assert.equal(followUp, first);
  releaseFirstEntries();
  await first;

  assert.equal(entryCalls, 2);
});

test('disposing during refresh prevents the old runtime from committing state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-disposed-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  await mkdir(projectPath);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let workspaceCalls = 0;
  let workspaceSignal: AbortSignal | undefined;
  const workspaces = {
    getWorkspaceInfo: async (_manifest: string, options?: { readonly signal?: AbortSignal }) => {
      workspaceCalls += 1;
      workspaceSignal = options?.signal;
      markStarted();
      await gate;
      return { manifest: manifestPath, name: 'demo' };
    },
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );

  const refresh = manager.refresh(undefined);
  await started;
  manager.dispose();
  assert.equal(workspaceSignal?.aborted, true);
  release();
  await refresh;
  await manager.refresh(undefined);

  assert.equal(workspaceCalls, 1);
  assert.deepEqual(await manager.getEnvironments('all'), []);
});

test('clearCache waits for aborted conda information before allowing replacement work', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-clear-enrichment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  let calls = 0;
  let active = 0;
  let maximumActive = 0;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: async ({ signal }) => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => setImmediate(resolve), { once: true });
          });
        }
        active -= 1;
        return undefined;
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await manager.clearCache();
  assert.equal(active, 0);
  await manager.refresh(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
});

test('clearCache serializes invalidation and refresh before replacement enrichment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-clear-interleaving-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  const staleDirectory = path.join(root, 'stale-envs');
  const stalePrefix = path.join(staleDirectory, 'stale');
  const winningDirectory = path.join(root, 'winning-envs');
  const winningPrefix = path.join(winningDirectory, 'winner');
  await Promise.all([
    mkdir(projectPath),
    mkdir(path.join(stalePrefix, 'conda-meta'), { recursive: true }),
    mkdir(path.join(winningPrefix, 'conda-meta'), { recursive: true }),
  ]);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');
  const enrichmentCalls: {
    readonly force: boolean;
    readonly signal: AbortSignal;
    readonly resolve: (info: CondaInfo | undefined) => void;
  }[] = [];
  const saved: (CondaInfo | undefined)[] = [];
  let workspaceCalls = 0;
  const workspaces = {
    getWorkspaceInfo: async () => {
      workspaceCalls += 1;
      return { manifest: manifestPath, name: 'demo' };
    },
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
      enrichCondaInfo: ({ force, signal }) =>
        new Promise<CondaInfo | undefined>((resolve) => {
          enrichmentCalls.push({ force, signal, resolve });
        }),
      saveCondaInfo: (info) => {
        saved.push(info);
      },
    },
  );
  t.after(() => manager.dispose());

  await manager.getEnvironments('all');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 1);
  assert.equal(workspaceCalls, 1);

  const clearing = manager.clearCache();
  manager.invalidateCondaInfo();
  manager.invalidateCondaInfo();
  const refresh = manager.refresh(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enrichmentCalls.length, 1);
  assert.equal(enrichmentCalls[0]?.signal.aborted, true);
  assert.equal(workspaceCalls, 1);

  enrichmentCalls[0]?.resolve(condaInfo(installation, [stalePrefix], staleDirectory));
  await clearing;
  assert.deepEqual(saved, [undefined]);
  assert.equal(enrichmentCalls.length, 2);
  assert.equal(enrichmentCalls[1]?.force, true);

  const changed = new Promise<void>((resolve) => {
    const listener = manager.onDidChangeEnvironments(() => {
      listener.dispose();
      resolve();
    });
  });
  enrichmentCalls[1]?.resolve(condaInfo(installation, [winningPrefix], winningDirectory));
  await Promise.all([refresh, changed]);

  assert.deepEqual(saved, [undefined, condaInfo(installation, [winningPrefix], winningDirectory)]);
  assert.ok(workspaceCalls >= 2);
  const environments = await manager.getEnvironments('all');
  assert.equal(
    environments.some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === stalePrefix,
    ),
    false,
  );
  assert.equal(
    environments.some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === winningPrefix,
    ),
    true,
  );
});

test('reads keep serving the committed snapshot during refresh', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-refresh-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  await mkdir(projectPath);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');

  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const workspaces = {
    getWorkspaceInfo: async () => {
      markRefreshStarted();
      await refreshGate;
      return { manifest: manifestPath, name: 'demo' };
    },
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [];
  vscode.__state.folders = [{ uri: project }];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
        includeGlobalSources: false,
      },
    },
  );
  t.after(() => manager.dispose());
  const before = await manager.getEnvironments('all');

  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  const refresh = manager.refresh(undefined);
  await refreshStarted;
  const readResult = await Promise.race([
    manager.getEnvironments('all').then((environments: PythonEnvironment[]) => ({
      kind: 'read' as const,
      environments,
    })),
    new Promise<{ readonly kind: 'blocked' }>((resolve) =>
      setImmediate(() => resolve({ kind: 'blocked' })),
    ),
  ]);

  releaseRefresh();
  await refresh;
  assert.equal(readResult.kind, 'read');
  if (readResult.kind === 'read') {
    assert.deepEqual(
      readResult.environments.map((environment) => environment.envId.id),
      before.map((environment: PythonEnvironment) => environment.envId.id),
    );
  }
});

test('cached regular discovery notices registry changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-refresh-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const executable = await createCondaInstallation(installation);
  const external = path.join(root, 'external');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: '' },
        userHome: home,
        standardRoots: [],
      },
    },
  );
  t.after(() => manager.dispose());

  assert.deepEqual(
    (await manager.getEnvironments('all')).map(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath,
    ),
    [await canonicalCondaPath(installation)],
  );

  await mkdir(path.join(external, 'conda-meta'), { recursive: true });
  await mkdir(path.join(home, '.conda'), { recursive: true });
  await writeFile(path.join(home, '.conda', 'environments.txt'), `${external}\n`);
  await manager.refresh(undefined);

  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === external,
    ),
    true,
  );
});

test('cached regular discovery notices the first environment in a secondary installation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-secondary-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const executable = await createCondaInstallation(primary);
  const secondaryExecutable = await createCondaInstallation(secondary);
  const secondaryNamed = path.join(secondary, 'envs', 'first');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    {
      executable,
      getInfo: async () => {
        throw new Error('regular discovery must not call conda info');
      },
    } as unknown as CondaClient,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
    {
      discovery: {
        environment: { PATH: path.dirname(secondaryExecutable) },
        userHome: home,
        standardRoots: [],
      },
    },
  );
  t.after(() => manager.dispose());

  const before = await manager.getEnvironments('all');
  assert.deepEqual(
    new Set(before.map((environment: PythonEnvironment) => environment.environmentPath.fsPath)),
    new Set([await canonicalCondaPath(primary), await canonicalCondaPath(secondary)]),
  );

  await mkdir(path.join(secondaryNamed, 'conda-meta'), { recursive: true });
  await manager.refresh(undefined);

  assert.deepEqual(
    new Set(
      (await manager.getEnvironments('all')).map((environment: PythonEnvironment) => [
        environment.environmentPath.fsPath,
        environment.group,
      ]),
    ),
    new Set([
      [await canonicalCondaPath(primary), undefined],
      [await canonicalCondaPath(secondary), undefined],
      [await canonicalCondaPath(secondaryNamed), 'Named'],
    ]),
  );
});

test('regular environments use the native conda base, named, and prefix groups', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-environment-groups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const envsDir = path.join(base, 'envs');
  const named = path.join(envsDir, 'named');
  const prefix = path.join(root, 'project', '.conda');
  await Promise.all(
    [base, named, prefix].map((environment) =>
      mkdir(path.join(environment, 'conda-meta'), { recursive: true }),
    ),
  );

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const conda = {
    getInfo: async () => condaInfo(base, [named, prefix], envsDir),
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const environments = await manager.getEnvironments('all');
  const groups = new Map(
    environments.map((environment: PythonEnvironment) => [
      environment.environmentPath.fsPath,
      environment.group,
    ]),
  );
  assert.equal(groups.get(base), undefined);
  assert.equal(groups.get(named), 'Named');
  assert.equal(groups.get(prefix), 'Prefix');
});

test('regular environments retain installation ownership across duplicate names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-installation-owners-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const primaryNamed = path.join(primary, 'envs', 'duplicate');
  const secondaryNamed = path.join(secondary, 'envs', 'duplicate');
  const [primaryExecutable, secondaryExecutable] = await Promise.all([
    createCondaInstallation(primary),
    createCondaInstallation(secondary),
  ]);
  await Promise.all(
    [primaryNamed, secondaryNamed].map((prefix) =>
      mkdir(path.join(prefix, 'conda-meta'), { recursive: true }),
    ),
  );

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  const routedRemovals: { executable: string; prefix: string }[] = [];
  const conda = {
    getInfo: async () => condaInfo(primary, [primaryNamed, secondary], path.join(primary, 'envs')),
    forExecutable: (executable: string) => ({
      removeEnvironment: async (prefix: string) => {
        routedRemovals.push({ executable, prefix });
      },
    }),
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const environments = await manager.getEnvironments('all');
  const byPrefix = new Map(
    environments.map((environment: PythonEnvironment) => [
      environment.environmentPath.fsPath,
      environment,
    ]),
  );
  assert.equal(byPrefix.get(primary)?.group, undefined);
  assert.equal(byPrefix.get(secondary)?.group, undefined);
  assert.equal(byPrefix.get(primaryNamed)?.group, 'Named');
  assert.equal(byPrefix.get(secondaryNamed)?.group, 'Named');
  assert.deepEqual(
    new Set(
      (await manager.getEnvironments('global')).map(
        (environment: PythonEnvironment) => environment.environmentPath.fsPath,
      ),
    ),
    new Set([primary, secondary]),
  );
  assert.equal(
    byPrefix.get(primaryNamed)?.execInfo.shellActivation?.get('bash')?.[0]?.args?.[0],
    path.join(await canonicalCondaPath(primary), 'etc', 'profile.d', 'conda.sh'),
  );
  assert.equal(
    byPrefix.get(secondaryNamed)?.execInfo.shellActivation?.get('bash')?.[0]?.args?.[0],
    path.join(await canonicalCondaPath(secondary), 'etc', 'profile.d', 'conda.sh'),
  );

  const secondaryEnvironment = byPrefix.get(secondaryNamed);
  assert.ok(secondaryEnvironment);
  await manager.remove(secondaryEnvironment);
  assert.deepEqual(routedRemovals, [
    {
      executable: await canonicalCondaPath(secondaryExecutable),
      prefix: secondaryNamed,
    },
  ]);
  assert.notEqual(primaryExecutable, secondaryExecutable);
});

test('quick create uses a project environment file before creating a workspace', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-environment-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const environmentFile = path.join(projectPath, 'environment.yml');
  const envsDir = path.join(root, 'envs');
  const existingPrefix = path.join(envsDir, 'project');
  const prefix = path.join(envsDir, 'project-1');
  await mkdir(projectPath);
  await mkdir(path.join(existingPrefix, 'conda-meta'), { recursive: true });
  await writeFile(environmentFile, 'name: demo\ndependencies:\n  - pytest\n');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(environmentFile)];
  vscode.__state.folders = [{ uri: project }];
  let info = {
    ...condaInfo(path.join(root, 'base'), [existingPrefix], envsDir),
    envsDetails: { [existingPrefix]: { name: 'project' } },
  };
  let createdFrom: string | undefined;
  let createdName: string | undefined;
  let disabledDefaultPackages: boolean | undefined;
  const installed: { prefix: string; specs: readonly string[] }[] = [];
  const conda = {
    getInfo: async () => info,
    createEnvironmentFromFile: async (
      file: string,
      name: string,
      options: { readonly noDefaultPackages?: boolean },
    ) => {
      createdFrom = file;
      createdName = name;
      disabledDefaultPackages = options.noDefaultPackages;
      await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
      info = {
        ...info,
        envs: [existingPrefix, prefix],
        envsDetails: {
          [existingPrefix]: { name: 'project' },
          [prefix]: { name: 'project-1' },
        },
      };
      return prefix;
    },
    installPackages: async (target: string, specs: readonly string[]) => {
      installed.push({ prefix: target, specs });
    },
  } as unknown as CondaClient;
  let workspaceCreations = 0;
  const workspaces = {
    quickstart: async () => {
      workspaceCreations += 1;
      throw new Error('workspace quickstart should not run');
    },
  } as unknown as CondaWorkspacesClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const created = await manager.create(project, {
    quickCreate: true,
    additionalPackages: ['ruff'],
  });

  assert.equal(createdFrom, environmentFile);
  assert.equal(createdName, 'project-1');
  assert.equal(disabledDefaultPackages, false);
  assert.equal(created?.environmentPath.fsPath, prefix);
  assert.equal(created?.version, 'no-python');
  assert.deepEqual(installed, [{ prefix, specs: ['ruff'] }]);
  assert.equal(workspaceCreations, 0);
});

test('quick create uses a CEP 23 explicit file without changing the lock', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-explicit-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const explicitFile = path.join(projectPath, 'explicit.txt');
  const envsDir = path.join(root, 'envs');
  const prefix = path.join(envsDir, 'project');
  await mkdir(projectPath);
  await writeFile(explicitFile, '@EXPLICIT\nhttps://example.invalid/python.tar.bz2\n');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(explicitFile)];
  vscode.__state.folders = [{ uri: project }];
  let info = condaInfo(path.join(root, 'base'), [], envsDir);
  let createCalls = 0;
  const conda = {
    getInfo: async () => info,
    createEnvironmentFromFile: async (
      file: string,
      name: string,
      options: { readonly noDefaultPackages?: boolean },
    ) => {
      createCalls += 1;
      assert.equal(file, explicitFile);
      assert.equal(name, 'project');
      assert.equal(options.noDefaultPackages, true);
      await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
      info = {
        ...info,
        envs: [prefix],
        envsDetails: { [prefix]: { name: 'project' } },
      };
      return prefix;
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  await assert.rejects(
    manager.create(project, {
      quickCreate: true,
      additionalPackages: ['ruff'],
    }),
    /Additional packages would change the environment locked by explicit\.txt/,
  );
  assert.equal(createCalls, 0);

  const created = await manager.create(project, { quickCreate: true });
  assert.equal(created?.environmentPath.fsPath, prefix);
  assert.equal(createCalls, 1);
});

test('quick create rejects multiple project environment inputs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-environment-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const environmentFile = path.join(projectPath, 'environment.yaml');
  const lockFile = path.join(projectPath, 'conda-lock.yml');
  await mkdir(projectPath);
  await writeFile(environmentFile, 'dependencies:\n  - python\n');
  await writeFile(lockFile, 'version: 1\nmetadata: {}\npackage: []\n');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(environmentFile), vscode.Uri.file(lockFile)];
  vscode.__state.folders = [{ uri: project }];
  let createCalls = 0;
  const conda = {
    getInfo: async () => condaInfo(path.join(root, 'base')),
    createEnvironmentFromFile: async () => {
      createCalls += 1;
      throw new Error('environment creation should not run');
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  await assert.rejects(
    manager.create(project, { quickCreate: true }),
    /Multiple project environment definitions found/,
  );
  assert.equal(createCalls, 0);
});

test('partial workspace failure retains the failed sibling and drops a healthy deletion', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-workspace-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  await mkdir(projectPath);
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  const manifest = vscode.Uri.file(manifestPath);
  vscode.__state.files = [manifest];
  vscode.__state.folders = [{ uri: project }];
  const defaultPrefix = path.join(projectPath, '.conda', 'envs', 'default');
  const removedPrefix = path.join(projectPath, '.conda', 'envs', 'removed');
  const installed = (name: string, prefix: string): InstalledWorkspaceEnvironment => ({
    name,
    prefix,
    condaDependencies: { python: '>=3.13' },
    features: [],
    python: {
      version: '3.13.5',
      executable: path.join(prefix, 'bin', 'python'),
    },
  });
  let partialFailure = false;
  const workspaces = {
    getWorkspaceInfo: async () => ({ manifest: manifestPath, name: 'demo' }),
    discoverInstalledEnvironments: async () =>
      partialFailure
        ? {
            environments: [],
            failures: [{ environmentName: 'default', error: new Error('temporary failure') }],
          }
        : {
            environments: [
              installed('default', defaultPrefix),
              installed('removed', removedPrefix),
            ],
            failures: [],
          },
  } as unknown as CondaWorkspacesClient;
  const conda = {
    getInfo: async () => condaInfo(path.join(root, 'base')),
  } as unknown as CondaClient;
  const selections = new CondaSelectionState(memory());
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    workspaces,
    selections,
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  await manager.refresh(undefined);
  const before = await manager.getEnvironments('all');
  assert.deepEqual(
    (await manager.getWorkspaceManifests()).map((uri) => uri.fsPath),
    [manifestPath],
  );
  const selected = before.find((environment: PythonEnvironment) => environment.name === 'default');
  assert.ok(selected);
  assert.deepEqual(before.map((environment: PythonEnvironment) => environment.name).sort(), [
    'default',
    'removed',
  ]);
  await manager.set(project, selected);

  partialFailure = true;
  await manager.refresh(undefined);
  const after = await manager.getEnvironments('all');
  assert.deepEqual(
    after.map((environment: PythonEnvironment) => environment.name),
    ['default'],
  );
  assert.equal((await manager.get(project))?.envId.id, selected.envId.id);
  assert.equal((await selections.entries())[project.toString(true)], defaultPrefix);
});

test('resolve respects failed workspace prefix and project reservations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-workspace-reservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  const prefix = path.join(projectPath, '.conda', 'envs', 'default');
  const python = path.join(prefix, 'bin', 'python');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h1_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
  );
  await writeFile(python, '');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const info = condaInfo(path.join(root, 'base'), [prefix]);
  const conda = {
    getInfo: async () => info,
  } as unknown as CondaClient;
  let reportPrefix = true;
  const workspaces = {
    getWorkspaceInfo: async () => ({ manifest: manifestPath, name: 'demo' }),
    discoverInstalledEnvironments: async () => ({
      environments: [],
      failures: [
        {
          environmentName: 'default',
          ...(reportPrefix ? { prefix } : {}),
          error: new Error('temporary failure'),
        },
      ],
    }),
  } as unknown as CondaWorkspacesClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    conda,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  await manager.refresh(undefined);
  assert.equal(await manager.resolve(vscode.Uri.file(python)), undefined);

  reportPrefix = false;
  await manager.refresh(undefined);
  assert.equal(await manager.resolve(vscode.Uri.file(python)), undefined);
  assert.equal(
    (await manager.getEnvironments('all')).some(
      (environment: PythonEnvironment) => environment.environmentPath.fsPath === prefix,
    ),
    false,
  );
});

test('workspace prefixes stay excluded through filesystem aliases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-workspace-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const manifestPath = path.join(projectPath, 'conda.toml');
  const prefix = path.join(root, 'workspace-environment');
  const alias = path.join(root, 'registered-alias');
  const python = path.join(prefix, 'bin', 'python');
  await mkdir(projectPath);
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(manifestPath, '[workspace]\nname = "demo"\n');
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h1_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
  );
  await writeFile(python, '');
  await symlink(prefix, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  const project = vscode.Uri.file(projectPath);
  vscode.__state.files = [vscode.Uri.file(manifestPath)];
  vscode.__state.folders = [{ uri: project }];
  const workspaces = {
    getWorkspaceInfo: async () => ({ manifest: manifestPath, name: 'demo' }),
    discoverInstalledEnvironments: async () => ({
      environments: [
        {
          name: 'default',
          prefix,
          condaDependencies: { python: '>=3.13' },
          features: [],
          python: { version: '3.13.5', executable: python },
        },
      ],
      failures: [],
    }),
  } as unknown as CondaWorkspacesClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([project]),
    {
      getInfo: async () => condaInfo(path.join(root, 'base'), [alias]),
    } as unknown as CondaClient,
    workspaces,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const environments = await manager.getEnvironments('all');
  assert.equal(environments.length, 1);
  assert.equal(environments[0]?.environmentPath.fsPath, prefix);
  assert.equal(environments[0]?.description, 'conda workspace environment');
});

test('remove rejects a symlinked named environment before calling conda', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-symlink-removal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envsDir = path.join(root, 'envs');
  const target = path.join(root, 'target');
  const prefix = path.join(envsDir, 'demo');
  await mkdir(path.join(target, 'conda-meta'), { recursive: true });
  await mkdir(envsDir);
  await symlink(target, prefix, process.platform === 'win32' ? 'junction' : 'dir');

  const { vscode, environmentManager, CondaSelectionState } = modules();
  vscode.__state.files = [];
  vscode.__state.folders = [];
  let removalCalls = 0;
  const info = {
    ...condaInfo(path.join(root, 'base'), [prefix], envsDir),
    envsDetails: { [prefix]: { name: 'demo' } },
  };
  const conda = {
    getInfo: async () => info,
    removeEnvironment: async () => {
      removalCalls += 1;
    },
  } as unknown as CondaClient;
  const manager = new environmentManager.CondaEnvironmentManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    new CondaSelectionState(memory()),
    'jezdez.conda-code:conda',
  );
  t.after(() => manager.dispose());

  const environment = (await manager.getEnvironments('all')).find(
    (candidate: PythonEnvironment) => candidate.environmentPath.fsPath === prefix,
  );
  assert.ok(environment);
  await assert.rejects(
    manager.remove(environment),
    /does not have enough ownership information for safe removal/,
  );
  assert.equal(removalCalls, 0);
});

test('workspace package changes reject operations that cannot preserve the manifest', async (t) => {
  const { vscode, packageManager } = modules();
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const prefix = '/work/demo/.conda/envs/default';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const route = {
    projectUri,
    manifestUri,
    environmentName: 'default',
    features: [],
    directCondaDependencies: ['python', 'numpy'],
    prefix,
    pythonPath: `${prefix}/bin/python`,
  };
  const routes = {
    getRoute: () => route,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as CondaWorkspaceRouteManager;
  let workspaceCalls = 0;
  const workspaces = {
    addDependencies: async () => {
      workspaceCalls += 1;
    },
  } as unknown as CondaWorkspacesClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    workspaces,
    routes,
  );
  t.after(() => packages.dispose());

  await assert.rejects(
    packages.manage(environment, { install: ['numpy'], upgrade: true }),
    /Conda workspace package upgrades are not supported/,
  );
  await assert.rejects(
    packages.manage(environment, { uninstall: ['numpy'] }),
    /Conda workspace package removal is not supported/,
  );
  assert.equal(workspaceCalls, 0);
});

test('regular package operations use the environment owner', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = path.resolve('/alternate/envs/demo');
  const ownerExecutable = '/alternate/bin/conda';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => ownerExecutable,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  const operations: { readonly operation: string; readonly prefix: string }[] = [];
  const owner = {
    listPrefixPackages: async (target: string) => {
      operations.push({ operation: 'list', prefix: target });
      return [];
    },
    installPackages: async (target: string) => {
      operations.push({ operation: 'install', prefix: target });
    },
    removePackages: async (target: string) => {
      operations.push({ operation: 'remove', prefix: target });
    },
  } as unknown as CondaClient;
  const executables: string[] = [];
  const conda = {
    forExecutable: (executable: string) => {
      executables.push(executable);
      return owner;
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());

  await packages.manage(environment, {
    install: ['ruff'],
    uninstall: ['black'],
  });

  assert.deepEqual(executables, [ownerExecutable, ownerExecutable]);
  assert.deepEqual(operations, [
    { operation: 'remove', prefix },
    { operation: 'install', prefix },
    { operation: 'list', prefix },
  ]);
});

test('regular package changes reject an environment without an owner', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/unknown/prefix';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());

  await assert.rejects(
    packages.manage(environment, { install: ['ruff'] }),
    /Conda Code does not know which conda installation owns/,
  );
});

test('package cache clearing invalidates records without reporting removals', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/opt/conda/envs/demo';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  let listCalls = 0;
  const conda = {
    listPrefixPackages: async () => {
      listCalls += 1;
      return [
        {
          name: 'python',
          version: '3.13.5',
          build: 'h1_0',
          channel: 'conda-forge',
        },
      ];
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  const events: { readonly changes: readonly { readonly kind: string }[] }[] = [];
  packages.onDidChangePackages((event) => events.push(event));

  assert.equal(
    (await packages.getPackages(environment))?.[0]?.description,
    'Build h1_0, Channel conda-forge',
  );
  await packages.clearCache();
  assert.equal(
    (await packages.getPackages(environment))?.[0]?.description,
    'Build h1_0, Channel conda-forge',
  );
  assert.equal(listCalls, 2);
  assert.deepEqual(events, []);
});

test('package refresh returns packages and skipCache reloads them', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/opt/conda/envs/demo';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  let listCalls = 0;
  let version = '3.13.1';
  const conda = {
    listPrefixPackages: async () => {
      listCalls += 1;
      return [
        {
          name: 'python',
          version,
          build: 'h1_0',
          channel: 'defaults',
        },
      ];
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  const events: { readonly changes: readonly { readonly kind: string }[] }[] = [];
  packages.onDidChangePackages((event) => events.push(event));

  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.1');
  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.1');
  assert.equal((await packages.getPackages(environment))?.[0]?.version, '3.13.1');
  assert.equal(listCalls, 2);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add']],
  );

  version = '3.13.2';
  assert.equal(
    (await packages.getPackages(environment, { skipCache: true }))?.[0]?.version,
    '3.13.2',
  );
  assert.equal(listCalls, 3);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add']],
  );

  version = '3.13.3';
  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.3');
  assert.equal(listCalls, 4);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add'], ['remove', 'add']],
  );
});
