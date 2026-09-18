import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import type { LogOutputChannel, Uri as VscodeUri } from 'vscode';

import type { WorkspaceActionEnvironmentManager, WorkspaceActionOptions } from './workspaceActions';
import type { CondaWorkspaceRoute } from './workspaceRouting';
import type { CondaWorkspacesClient, WorkspaceSnapshot, WorkspaceSbomOptions } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-workspace-sbom-test:vscode';
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
  static joinPath(base, ...parts) {
    return Uri.file(path.join(base.fsPath, ...parts));
  }
  toString() {
    return 'file://' + this.fsPath;
  }
}

const __state = {
  destination: undefined,
  errors: [],
  information: [],
  progress: [],
  quickPickCalls: [],
  quickPickResults: [],
  saveDialogCalls: [],
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
  showSaveDialog: async (options) => {
    __state.saveDialogCalls.push(options);
    return __state.destination;
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
    destination: VscodeUri | undefined;
    errors: string[];
    information: string[];
    progress: { readonly location: number; readonly title: string }[];
    quickPickCalls: {
      readonly items: readonly { readonly label: string; readonly description?: string }[];
      readonly options: Record<string, unknown>;
    }[];
    quickPickResults: (number | undefined)[];
    saveDialogCalls: {
      readonly defaultUri: VscodeUri;
      readonly filters: Record<string, readonly string[]>;
      readonly saveLabel: string;
      readonly title: string;
    }[];
  };
}

interface ExportCall {
  readonly manifest: string;
  readonly environment: string;
  readonly platform: string;
  readonly file: string;
  readonly options: WorkspaceSbomOptions;
}

class FakeEnvironments implements WorkspaceActionEnvironmentManager {
  public manifests: VscodeUri[];
  public readonly refreshCalls: VscodeUri[] = [];
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
    return [];
  }

  public getRoute(): CondaWorkspaceRoute | undefined {
    return undefined;
  }

  public async set(): Promise<void> {}
}

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const workspaceSbom = requireFromTest(
    './workspaceSbom.js',
  ) as typeof import('./workspaceSbom.js');
  return { vscode, workspaceSbom };
}

function reset(vscode: VscodeStub): void {
  vscode.__state.destination = undefined;
  vscode.__state.errors.length = 0;
  vscode.__state.information.length = 0;
  vscode.__state.progress.length = 0;
  vscode.__state.quickPickCalls.length = 0;
  vscode.__state.quickPickResults.length = 0;
  vscode.__state.saveDialogCalls.length = 0;
}

function projectApi(project: VscodeUri): PythonEnvironmentApi {
  return {
    getPythonProject: (uri: VscodeUri) =>
      uri.fsPath.startsWith(project.fsPath) ? { uri: project } : undefined,
  } as PythonEnvironmentApi;
}

function snapshot(
  manifest = path.resolve('/work/demo/conda.toml'),
  environments: WorkspaceSnapshot['environments'] = [
    {
      name: 'analysis',
      features: ['cuda'],
      platforms: ['linux-base', 'linux-cuda'],
      prefix: path.resolve('/work/demo/.conda/envs/analysis'),
      installed: false,
      resolutions: [
        { platform: 'linux-base', subdir: 'linux-64', dependencies: [] },
        { platform: 'linux-cuda', subdir: 'linux-64', dependencies: [] },
      ],
      packages: [],
    },
  ],
): WorkspaceSnapshot {
  return { manifest, name: 'demo', environments };
}

function options(
  vscode: VscodeStub,
  calls: ExportCall[],
  snapshots: WorkspaceSnapshot[] = [snapshot(), snapshot()],
): WorkspaceActionOptions & {
  readonly environments: FakeEnvironments;
  readonly snapshotCalls: string[];
} {
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const environments = new FakeEnvironments(manifestUri);
  const snapshotCalls: string[] = [];
  let snapshotIndex = 0;
  const workspaces = {
    getWorkspaceInfo: async (manifest: string) => ({ manifest, name: 'demo' }),
    getWorkspaceSnapshot: async (manifest: string) => {
      snapshotCalls.push(manifest);
      return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
    },
    exportWorkspaceSbom: async (
      manifest: string,
      environment: string,
      platform: string,
      file: string,
      exportOptions: WorkspaceSbomOptions,
    ) => {
      calls.push({ manifest, environment, platform, file, options: exportOptions });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as CondaWorkspacesClient;
  return {
    api: projectApi(projectUri),
    environments,
    log: { error: () => undefined } as unknown as LogOutputChannel,
    scope: vscode.Uri.file('/work/demo/src/main.py'),
    snapshotCalls,
    workspaces,
  };
}

test('workspace SBOM export uses an uninstalled declaration and preserves its rich platform', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls);
  const destination = vscode.Uri.file('/work/demo/analysis-linux-cuda.cdx.json');
  vscode.__state.quickPickResults.push(0, 1, 0);
  vscode.__state.destination = destination;

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls, [
    {
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'analysis',
      platform: 'linux-cuda',
      file: destination.fsPath,
      options: { reproducible: true },
    },
  ]);
  const visibleItems = (index: number) =>
    vscode.__state.quickPickCalls[index]?.items.map(({ label, description }) => ({
      label,
      description,
    }));
  assert.deepEqual(visibleItems(0), [
    { label: 'analysis', description: 'Not installed · Features: cuda' },
  ]);
  assert.deepEqual(visibleItems(1), [
    { label: 'linux-base', description: 'Conda subdir: linux-64' },
    { label: 'linux-cuda', description: 'Conda subdir: linux-64' },
  ]);
  assert.deepEqual(visibleItems(2), [
    { label: 'Reproducible', description: 'Omit the SBOM timestamp' },
    { label: 'Timestamped', description: 'Include the generation timestamp' },
  ]);
  assert.deepEqual(vscode.__state.saveDialogCalls, [
    {
      defaultUri: vscode.Uri.file('/work/demo/analysis-linux-cuda.cdx.json'),
      filters: { 'CycloneDX JSON': ['json'] },
      saveLabel: 'Export Workspace SBOM',
      title: 'Choose the workspace SBOM destination',
    },
  ]);
  assert.equal(actionOptions.environments.refreshCalls.length, 1);
  assert.equal(actionOptions.snapshotCalls.length, 2);
  assert.deepEqual(vscode.__state.progress, [
    { location: 15, title: 'Exporting analysis for linux-cuda from the workspace lockfile' },
  ]);
  assert.deepEqual(vscode.__state.information, [
    `Exported the analysis workspace SBOM for linux-cuda to ${destination.fsPath}.`,
  ]);
});

test('workspace SBOM export offers timestamped output without the reproducible option', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.quickPickResults.push(0, 0, 1);
  vscode.__state.destination = vscode.Uri.file('/work/demo/timestamped.cdx.json');

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls[0]?.options, { reproducible: false });
});

test('cancelling workspace platform selection does not refresh or export', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.quickPickResults.push(0, undefined);

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.saveDialogCalls, []);
  assert.deepEqual(vscode.__state.errors, []);
});

test('workspace SBOM export fails closed when ownership changes after the prompts', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.environments.removeOwnershipOnRefresh = true;
  vscode.__state.quickPickResults.push(0, 0, 0);
  vscode.__state.destination = vscode.Uri.file('/work/demo/analysis.cdx.json');

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /workspace ownership changed/i);
});

test('workspace SBOM export rejects a declaration removed after selection', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls, [snapshot(), snapshot(undefined, [])]);
  vscode.__state.quickPickResults.push(0, 0, 0);
  vscode.__state.destination = vscode.Uri.file('/work/demo/analysis.cdx.json');

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /declaration changed before export/i);
});

test('workspace SBOM export preserves missing plugin and invalid lockfile errors', async () => {
  const { vscode, workspaceSbom } = modules();
  for (const [backendError, expected] of [
    [
      'SBOM export requires conda-sboms >=0.3.0. Install or upgrade it with: conda install -n base "conda-forge::conda-sboms>=0.3.0"',
      /conda-sboms >=0\.3\.0/,
    ],
    ['Lockfile has no exact records for analysis on linux-base', /no exact records/],
  ] as const) {
    reset(vscode);
    const calls: ExportCall[] = [];
    const actionOptions = options(vscode, calls);
    actionOptions.workspaces.exportWorkspaceSbom = async () => {
      throw new Error(backendError);
    };
    vscode.__state.quickPickResults.push(0, 0, 0);
    vscode.__state.destination = vscode.Uri.file('/work/demo/analysis.cdx.json');

    await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

    assert.deepEqual(calls, []);
    assert.match(vscode.__state.errors[0] ?? '', expected);
  }
});

test('workspace SBOM export identifies an unsupported conda-workspaces backend', async () => {
  const { vscode, workspaceSbom } = modules();
  reset(vscode);
  const calls: ExportCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.workspaces.getWorkspaceSnapshot = async () => {
    throw new Error('conda workspace: error: unrecognized arguments: --packages');
  };

  await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /conda-workspaces 0\.9 or newer/);
});

test('workspace SBOM export rejects a changed manifest or selected platform', async () => {
  const { vscode, workspaceSbom } = modules();
  const original = snapshot();
  const environment = original.environments[0]!;
  for (const changed of [
    snapshot(path.resolve('/work/other/conda.toml')),
    snapshot(undefined, [{ ...environment, resolutions: [environment.resolutions[0]!] }]),
  ]) {
    reset(vscode);
    const calls: ExportCall[] = [];
    const actionOptions = options(vscode, calls, [original, changed]);
    vscode.__state.quickPickResults.push(0, 1, 0);
    vscode.__state.destination = vscode.Uri.file('/work/demo/analysis.cdx.json');

    await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

    assert.deepEqual(calls, []);
    assert.deepEqual(vscode.__state.information, []);
    assert.match(vscode.__state.errors[0] ?? '', /(?:ownership|platform declaration) changed/i);
  }
});

test('cancelling SBOM environment, output mode, or destination performs no export', async () => {
  const { vscode, workspaceSbom } = modules();
  for (const picks of [[undefined], [0, 0, undefined], [0, 0, 0]]) {
    reset(vscode);
    const calls: ExportCall[] = [];
    const actionOptions = options(vscode, calls);
    vscode.__state.quickPickResults.push(...picks);
    if (picks.includes(undefined)) {
      vscode.__state.destination = vscode.Uri.file('/work/demo/analysis.cdx.json');
    }

    await workspaceSbom.exportWorkspaceLockfileSbom(actionOptions);

    assert.deepEqual(calls, []);
    assert.deepEqual(actionOptions.environments.refreshCalls, []);
    assert.deepEqual(vscode.__state.information, []);
    assert.deepEqual(vscode.__state.errors, []);
    assert.equal(vscode.__state.saveDialogCalls.length, picks.includes(undefined) ? 0 : 1);
  }
});
