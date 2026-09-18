import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import type { LogOutputChannel, Uri as VscodeUri } from 'vscode';

import type { WorkspaceActionEnvironmentManager, WorkspaceActionOptions } from './workspaceActions';
import type { CondaWorkspaceRoute } from './workspaceRouting';
import type { CondaWorkspacesClient, WorkspaceEnvironment, WorkspaceInfo } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-workspace-locks-test:vscode';
const VSCODE_STUB_SOURCE = String.raw`
const path = require('node:path');

class Uri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
  }
  static file(value) {
    return new Uri(value);
  }
  toString() {
    return 'file://' + this.fsPath;
  }
}

const __state = {
  errors: [],
  information: [],
  progress: [],
  quickPickCalls: [],
  quickPickResults: [],
};

const window = {
  showErrorMessage: async (message) => {
    __state.errors.push(message);
    return undefined;
  },
  showInformationMessage: async (message) => {
    __state.information.push(message);
    return undefined;
  },
  showQuickPick: async (items, options) => {
    __state.quickPickCalls.push({ items, options });
    const result = __state.quickPickResults.shift();
    return result === undefined ? undefined : items[result];
  },
  withProgress: async (options, task) => {
    __state.progress.push(options);
    return task({ report: () => undefined });
  },
};

const ProgressLocation = { Notification: 15 };

module.exports = { __state, ProgressLocation, Uri, window };
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
    errors: string[];
    information: string[];
    progress: { readonly location: number; readonly title: string }[];
    quickPickCalls: {
      readonly items: readonly { readonly label: string; readonly description?: string }[];
      readonly options: Record<string, unknown>;
    }[];
    quickPickResults: (number | undefined)[];
  };
}

interface LockCall {
  readonly operation: 'lock' | 'locked-install';
  readonly manifest: string;
  readonly environment?: string;
}

class FakeEnvironments implements WorkspaceActionEnvironmentManager {
  public manifests: VscodeUri[];
  public environments: PythonEnvironment[] = [];
  public readonly refreshCalls: VscodeUri[] = [];
  public readonly routes = new Map<PythonEnvironment, CondaWorkspaceRoute>();
  public readonly setCalls: {
    readonly scope: VscodeUri;
    readonly environment?: PythonEnvironment;
  }[] = [];
  public removeOwnershipOnRefresh = false;

  public constructor(manifest: VscodeUri) {
    this.manifests = [manifest];
  }

  public async getWorkspaceManifests(): Promise<VscodeUri[]> {
    return [...this.manifests];
  }

  public async refresh(scope: VscodeUri): Promise<void> {
    this.refreshCalls.push(scope);
    if (this.removeOwnershipOnRefresh) {
      this.manifests = [];
    }
  }

  public async getEnvironments(): Promise<PythonEnvironment[]> {
    return [...this.environments];
  }

  public getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routes.get(environment);
  }

  public async set(scope: VscodeUri, environment?: PythonEnvironment): Promise<void> {
    this.setCalls.push({ scope, environment });
  }
}

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const locks = requireFromTest('./workspaceLocks.js') as typeof import('./workspaceLocks.js');
  return { locks, vscode };
}

function reset(vscode: VscodeStub): void {
  vscode.__state.errors.length = 0;
  vscode.__state.information.length = 0;
  vscode.__state.progress.length = 0;
  vscode.__state.quickPickCalls.length = 0;
  vscode.__state.quickPickResults.length = 0;
}

function projectApi(project: VscodeUri): PythonEnvironmentApi {
  return {
    getPythonProject: (uri: VscodeUri) =>
      uri.fsPath.startsWith(project.fsPath) ? { uri: project } : undefined,
  } as PythonEnvironmentApi;
}

function options(
  vscode: VscodeStub,
  calls: LockCall[],
  info: WorkspaceInfo,
  declarations: readonly WorkspaceEnvironment[] = [],
): WorkspaceActionOptions & { readonly environments: FakeEnvironments } {
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const environments = new FakeEnvironments(manifestUri);
  const workspaces = {
    getWorkspaceInfo: async () => info,
    listEnvironments: async () => declarations,
    updateLockfile: async (manifest: string) => {
      calls.push({ operation: 'lock', manifest });
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
    installLockedEnvironment: async (manifest: string, environment: string) => {
      calls.push({ operation: 'locked-install', manifest, environment });
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
  } as unknown as CondaWorkspacesClient;
  return {
    api: projectApi(projectUri),
    environments,
    log: { error: () => undefined } as unknown as LogOutputChannel,
    scope: vscode.Uri.file('/work/demo/src/main.py'),
    workspaces,
  };
}

function addInstalledEnvironment(
  vscode: VscodeStub,
  actionOptions: WorkspaceActionOptions & { readonly environments: FakeEnvironments },
  name: string,
): PythonEnvironment {
  const environment = {
    name,
    displayName: name,
    envId: { id: name, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(`/work/demo/.conda/envs/${name}`),
  } as PythonEnvironment;
  actionOptions.environments.environments = [environment];
  actionOptions.environments.routes.set(environment, {
    projectUri: vscode.Uri.file('/work/demo'),
    manifestUri: vscode.Uri.file('/work/demo/conda.toml'),
    environmentName: name,
  } as CondaWorkspaceRoute);
  return environment;
}

test('lock status reports stale and missing workspaces without installed environments', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const actionOptions = options(vscode, calls, {
    manifest: path.resolve('/work/demo/conda.toml'),
    name: 'demo',
    lockfileStatus: 'out-of-date',
    lockfileReason: 'feature test changed',
  });

  await locks.showWorkspaceLockStatus(actionOptions);

  assert.deepEqual(vscode.__state.information, [
    'Workspace lockfile is stale: feature test changed.',
  ]);
  assert.deepEqual(calls, []);
  assert.equal(actionOptions.environments.refreshCalls.length, 1);

  reset(vscode);
  const missingOptions = options(vscode, calls, {
    manifest: path.resolve('/work/demo/conda.toml'),
    name: 'demo',
    lockfileStatus: 'missing',
  });
  await locks.showWorkspaceLockStatus(missingOptions);
  assert.deepEqual(vscode.__state.information, ['Workspace lockfile is missing.']);
});

test('updating the lockfile rechecks ownership and refreshes displayed state', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const actionOptions = options(vscode, calls, {
    manifest: path.resolve('/work/demo/conda.toml'),
    name: 'demo',
    lockfileStatus: 'out-of-date',
  });
  await locks.updateWorkspaceLockfile(actionOptions);

  assert.deepEqual(calls, [{ operation: 'lock', manifest: path.resolve('/work/demo/conda.toml') }]);
  assert.equal(actionOptions.environments.refreshCalls.length, 2);
  assert.deepEqual(vscode.__state.progress, [
    { location: 15, title: 'Updating workspace lockfile' },
  ]);
});

test('lockfile update fails closed when refreshed ownership disappears', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const actionOptions = options(vscode, calls, {
    manifest: path.resolve('/work/demo/conda.toml'),
    name: 'demo',
  });
  actionOptions.environments.removeOwnershipOnRefresh = true;
  await locks.updateWorkspaceLockfile(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /workspace ownership changed/i);
});

test('locked install selects a declaration and calls only the strict installer', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const declarations: WorkspaceEnvironment[] = [
    { name: 'default', features: [], installed: true },
    { name: 'docs', features: ['docs'], installed: false },
  ];
  const actionOptions = options(
    vscode,
    calls,
    {
      manifest: path.resolve('/work/demo/conda.toml'),
      name: 'demo',
      lockfileStatus: 'up-to-date',
    },
    declarations,
  );
  const installed = addInstalledEnvironment(vscode, actionOptions, 'docs');
  vscode.__state.quickPickResults.push(1);

  await locks.installLockedWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, [
    {
      operation: 'locked-install',
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'docs',
    },
  ]);
  assert.equal(actionOptions.environments.refreshCalls.length, 2);
  assert.equal(actionOptions.environments.setCalls[0]?.environment, installed);
  assert.deepEqual(vscode.__state.quickPickCalls[0]?.items, [
    { label: 'default', description: 'Installed' },
    { label: 'docs', description: 'Not installed · Features: docs' },
  ]);
});

test('cancelling locked install does not refresh or mutate the workspace', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const actionOptions = options(
    vscode,
    calls,
    {
      manifest: path.resolve('/work/demo/conda.toml'),
      name: 'demo',
      lockfileStatus: 'up-to-date',
    },
    [{ name: 'default', features: [], installed: false }],
  );
  vscode.__state.quickPickResults.push(undefined);

  await locks.installLockedWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
});

test('locked install reports missing and stale lockfiles and never starts installation', async () => {
  const { locks, vscode } = modules();
  for (const [lockfileStatus, lockfileReason, expected] of [
    ['missing', undefined, /missing/i],
    ['out-of-date', 'dependency python changed', /stale: dependency python changed/i],
  ] as const) {
    reset(vscode);
    const calls: LockCall[] = [];
    const actionOptions = options(
      vscode,
      calls,
      {
        manifest: path.resolve('/work/demo/conda.toml'),
        name: 'demo',
        lockfileStatus,
        ...(lockfileReason === undefined ? {} : { lockfileReason }),
      },
      [{ name: 'default', features: [], installed: false }],
    );
    vscode.__state.quickPickResults.push(0);

    await locks.installLockedWorkspaceEnvironment(actionOptions);

    assert.deepEqual(calls, []);
    assert.match(vscode.__state.errors[0] ?? '', expected);
    assert.doesNotMatch(vscode.__state.errors[0] ?? '', /solver/i);
  }
});

test('new lock actions identify an unsupported conda-workspaces backend', async () => {
  const { locks, vscode } = modules();
  reset(vscode);
  const calls: LockCall[] = [];
  const actionOptions = options(vscode, calls, {
    manifest: path.resolve('/work/demo/conda.toml'),
    name: 'demo',
  });
  actionOptions.workspaces.updateLockfile = async () => {
    throw new Error("invalid choice: 'lock'");
  };
  await locks.updateWorkspaceLockfile(actionOptions);

  assert.match(vscode.__state.errors[0] ?? '', /conda-workspaces 0\.10 or newer/);
});
