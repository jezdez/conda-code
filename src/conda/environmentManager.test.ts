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
    environmentManager.CondaLockfilePackagesError,
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
    environmentManager.CondaEnvironmentDefinitionConflictError,
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
    environmentManager.CondaEnvironmentRemovalError,
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
    packageManager.WorkspacePackageUpgradeError,
  );
  await assert.rejects(
    packages.manage(environment, { uninstall: ['numpy'] }),
    packageManager.WorkspacePackageRemovalError,
  );
  assert.equal(workspaceCalls, 0);
});

test('package cache clearing emits supported package removal changes', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/opt/conda/envs/demo';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  const conda = {
    listPrefixPackages: async () => [
      {
        name: 'python',
        version: '3.13.5',
        build: 'h1_0',
        channel: 'conda-forge',
      },
    ],
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

  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['remove']],
  );
});
