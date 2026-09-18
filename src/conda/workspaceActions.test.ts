import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import type { LogOutputChannel, Uri as VscodeUri } from 'vscode';

import type { WorkspaceActionEnvironmentManager, WorkspaceActionOptions } from './workspaceActions';
import type { CondaWorkspaceRoute } from './workspaceRouting';
import type {
  AddWorkspaceEnvironmentOptions,
  CondaWorkspacesClient,
  WorkspaceEnvironment,
} from './workspaces';

const VSCODE_STUB_URL = 'conda-code-workspace-actions-test:vscode';
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
  inputs: [],
  inputCalls: [],
  openDialogCalls: [],
  openDialogResult: undefined,
  progress: [],
  quickPickCalls: [],
  quickPickResults: [],
  warningCalls: [],
  warningResults: [],
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
  showInputBox: async (options) => {
    __state.inputCalls.push(options);
    return __state.inputs.shift();
  },
  showOpenDialog: async (options) => {
    __state.openDialogCalls.push(options);
    return __state.openDialogResult;
  },
  showQuickPick: async (items, options) => {
    __state.quickPickCalls.push({ items, options });
    const result = __state.quickPickResults.shift();
    if (Array.isArray(result)) {
      return result.map((index) => items[index]);
    }
    return result === undefined ? undefined : items[result];
  },
  showWarningMessage: async (message, options, ...items) => {
    __state.warningCalls.push({ message, options, items });
    return __state.warningResults.shift();
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
    inputs: (string | undefined)[];
    inputCalls: Record<string, unknown>[];
    openDialogCalls: Record<string, unknown>[];
    openDialogResult: VscodeUri[] | undefined;
    progress: { readonly location: number; readonly title: string }[];
    quickPickCalls: {
      readonly items: readonly { readonly label: string; readonly picked?: boolean }[];
      readonly options: Record<string, unknown>;
    }[];
    quickPickResults: (number | number[] | undefined)[];
    warningCalls: {
      readonly message: string;
      readonly options: Record<string, unknown>;
      readonly items: readonly string[];
    }[];
    warningResults: (string | undefined)[];
  };
}

interface WorkspaceCall {
  readonly operation: 'add' | 'import' | 'remove';
  readonly manifest: string;
  readonly environment: string;
  readonly file?: string;
  readonly options?: AddWorkspaceEnvironmentOptions;
}

class FakeEnvironments implements WorkspaceActionEnvironmentManager {
  public manifests: VscodeUri[];
  public environments: PythonEnvironment[] = [];
  public readonly refreshCalls: VscodeUri[] = [];
  public readonly setCalls: {
    readonly scope: VscodeUri;
    readonly environment?: PythonEnvironment;
  }[] = [];
  public removeOwnershipOnRefresh = false;

  public constructor(
    manifest: VscodeUri,
    public readonly routes: Map<PythonEnvironment, CondaWorkspaceRoute>,
  ) {
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
  const actions = requireFromTest(
    './workspaceActions.js',
  ) as typeof import('./workspaceActions.js');
  return { actions, vscode };
}

function reset(vscode: VscodeStub): void {
  vscode.__state.errors.length = 0;
  vscode.__state.information.length = 0;
  vscode.__state.inputs.length = 0;
  vscode.__state.inputCalls.length = 0;
  vscode.__state.openDialogCalls.length = 0;
  vscode.__state.openDialogResult = undefined;
  vscode.__state.progress.length = 0;
  vscode.__state.quickPickCalls.length = 0;
  vscode.__state.quickPickResults.length = 0;
  vscode.__state.warningCalls.length = 0;
  vscode.__state.warningResults.length = 0;
}

function projectApi(project: VscodeUri): PythonEnvironmentApi {
  return {
    getPythonProject: (uri: VscodeUri) => {
      const relative = path.relative(project.fsPath, uri.fsPath);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
        ? { uri: project }
        : undefined;
    },
  } as PythonEnvironmentApi;
}

function workspaceClient(
  calls: WorkspaceCall[],
  features: readonly string[] = ['default', 'cuda', 'docs'],
  environments: readonly WorkspaceEnvironment[] = [],
): CondaWorkspacesClient {
  return {
    getWorkspaceInfo: async (manifest: string) => ({ manifest, name: 'demo', features }),
    listEnvironments: async () => environments,
    addEnvironment: async (
      manifest: string,
      environment: string,
      options?: AddWorkspaceEnvironmentOptions,
    ) => {
      calls.push({ operation: 'add', manifest, environment, options });
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
    importEnvironment: async (manifest: string, environment: string, file: string) => {
      calls.push({ operation: 'import', manifest, environment, file });
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
    removeEnvironmentDeclaration: async (manifest: string, environment: string) => {
      calls.push({ operation: 'remove', manifest, environment });
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
  } as unknown as CondaWorkspacesClient;
}

function options(
  vscode: VscodeStub,
  calls: WorkspaceCall[],
  features?: readonly string[],
  declarations?: readonly WorkspaceEnvironment[],
): WorkspaceActionOptions & { readonly environments: FakeEnvironments } {
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const routes = new Map<PythonEnvironment, CondaWorkspaceRoute>();
  const environments = new FakeEnvironments(manifestUri, routes);
  return {
    api: projectApi(projectUri),
    environments,
    log: { error: () => undefined } as unknown as LogOutputChannel,
    scope: vscode.Uri.file('/work/demo/src/main.py'),
    workspaces: workspaceClient(calls, features, declarations),
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
  const route = {
    projectUri: vscode.Uri.file('/work/demo'),
    manifestUri: vscode.Uri.file('/work/demo/conda.toml'),
    environmentName: name,
  } as CondaWorkspaceRoute;
  actionOptions.environments.routes.set(environment, route);
  return environment;
}

test('workspace context selection prefers the workspace that owns the active scope', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const alpha = vscode.Uri.file('/work/alpha');
  const beta = vscode.Uri.file('/work/beta');
  const environmentManager = {
    getWorkspaceManifests: async () => [
      vscode.Uri.file('/work/alpha/conda.toml'),
      vscode.Uri.file('/work/beta/conda.toml'),
    ],
  } as WorkspaceActionEnvironmentManager;
  const api = {
    getPythonProject: (uri: VscodeUri) =>
      uri.fsPath.startsWith(alpha.fsPath) ? { uri: alpha } : { uri: beta },
  } as PythonEnvironmentApi;

  const context = await actions.selectWorkspaceActionContext({
    api,
    environments: environmentManager,
    scope: vscode.Uri.file('/work/beta/src/main.py'),
  });

  assert.equal(context?.projectUri.fsPath, beta.fsPath);
  assert.equal(context?.manifestUri.fsPath, path.join(beta.fsPath, 'conda.toml'));
  assert.deepEqual(vscode.__state.quickPickCalls, []);
});

test('creating a declaration composes selected features and selects the installed environment', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  const installed = addInstalledEnvironment(vscode, actionOptions, 'analysis');
  vscode.__state.inputs.push('analysis');
  vscode.__state.quickPickResults.push([0, 2]);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, [
    {
      operation: 'add',
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'analysis',
      options: { features: ['docs'], noDefaultFeature: false },
    },
  ]);
  assert.equal(vscode.__state.quickPickCalls[0]?.items[0]?.label, 'Default feature');
  assert.equal(vscode.__state.quickPickCalls[0]?.items[0]?.picked, true);
  assert.deepEqual(
    vscode.__state.quickPickCalls[0]?.items.map(({ label }) => label),
    ['Default feature', 'cuda', 'docs'],
  );
  assert.deepEqual(
    actionOptions.environments.refreshCalls.map(({ fsPath }) => fsPath),
    [path.resolve('/work/demo'), path.resolve('/work/demo')],
  );
  assert.equal(actionOptions.environments.setCalls[0]?.environment, installed);
  assert.deepEqual(vscode.__state.progress, [
    { location: 15, title: 'Creating workspace environment analysis' },
  ]);
  assert.deepEqual(vscode.__state.errors, []);
});

test('creating a declaration can omit the default feature', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls, ['default', 'test']);
  vscode.__state.inputs.push('minimal');
  vscode.__state.quickPickResults.push([1]);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls[0]?.options, { features: ['test'], noDefaultFeature: true });
});

test('cancelling declaration creation has no side effects', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.inputs.push(undefined);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.errors, []);
});

test('declaration creation fails closed when refreshed ownership disappears', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.environments.removeOwnershipOnRefresh = true;
  vscode.__state.inputs.push('analysis');
  vscode.__state.quickPickResults.push([0]);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /workspace ownership changed/i);
});

test('importing environment.yml refreshes and selects the imported environment', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  const installed = addInstalledEnvironment(vscode, actionOptions, 'legacy');
  const definition = vscode.Uri.file('/work/import/environment.yml');
  vscode.__state.openDialogResult = [definition];
  vscode.__state.inputs.push('legacy');

  await actions.importWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, [
    {
      operation: 'import',
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'legacy',
      file: definition.fsPath,
    },
  ]);
  assert.equal(actionOptions.environments.setCalls[0]?.environment, installed);
  assert.deepEqual(vscode.__state.errors, []);
});

test('cancelling the environment.yml picker does not refresh or mutate the workspace', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);

  await actions.importWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.errors, []);
});

test('workspace backend errors are reported without hiding their message', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.workspaces.importEnvironment = async () => {
    throw new Error('solver could not satisfy the imported environment');
  };
  vscode.__state.openDialogResult = [vscode.Uri.file('/work/import/environment.yaml')];
  vscode.__state.inputs.push('legacy');

  await actions.importWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /solver could not satisfy/);
  assert.doesNotMatch(vscode.__state.errors[0] ?? '', /0\.9 or newer/);
});

test('removing a declaration requires confirmation and rechecks the declaration', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls, undefined, [
    { name: 'analysis', features: ['test'], installed: true },
  ]);
  vscode.__state.warningResults.push('Remove Declaration');

  await actions.removeWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, [
    {
      operation: 'remove',
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'analysis',
    },
  ]);
  assert.equal(vscode.__state.warningCalls[0]?.options.modal, true);
  assert.equal(actionOptions.environments.refreshCalls.length, 2);
  assert.deepEqual(actionOptions.environments.setCalls, []);
});

test('cancelling declaration removal leaves the workspace unchanged', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls, undefined, [
    { name: 'analysis', features: [], installed: false },
  ]);
  vscode.__state.warningResults.push(undefined);

  await actions.removeWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
});

test('declaration removal fails closed when the declaration disappears during refresh', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls, undefined, [
    { name: 'analysis', features: [], installed: false },
  ]);
  let listCalls = 0;
  actionOptions.workspaces.listEnvironments = async () => {
    listCalls += 1;
    return listCalls === 1 ? [{ name: 'analysis', features: [], installed: false }] : [];
  };
  vscode.__state.warningResults.push('Remove Declaration');

  await actions.removeWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /declaration changed before removal/i);
});

test('old conda-workspaces lifecycle errors identify the required version', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.workspaces.addEnvironment = async () => {
    throw new Error("invalid choice: 'add'");
  };
  vscode.__state.inputs.push('analysis');
  vscode.__state.quickPickResults.push([0]);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.match(vscode.__state.errors[0] ?? '', /conda-workspaces 0\.9 or newer/);
});

test('old conda-workspaces named import errors identify the required version', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.workspaces.importEnvironment = async () => {
    throw new Error('conda workspace: error: unrecognized arguments: -e legacy');
  };
  vscode.__state.openDialogResult = [vscode.Uri.file('/work/import/environment.yml')];
  vscode.__state.inputs.push('legacy');

  await actions.importWorkspaceEnvironment(actionOptions);

  assert.match(vscode.__state.errors[0] ?? '', /conda-workspaces 0\.9 or newer/);
});

test('creation rejects features or a manifest changed while prompts were open', async () => {
  const { actions, vscode } = modules();
  for (const change of ['features', 'manifest'] as const) {
    reset(vscode);
    const calls: WorkspaceCall[] = [];
    const actionOptions = options(vscode, calls);
    let reads = 0;
    actionOptions.workspaces.getWorkspaceInfo = async (manifest) => {
      reads += 1;
      return {
        manifest:
          reads > 1 && change === 'manifest' ? path.resolve('/work/other/conda.toml') : manifest,
        name: 'demo',
        features: reads > 1 && change === 'features' ? [] : ['docs'],
      };
    };
    vscode.__state.inputs.push('analysis');
    vscode.__state.quickPickResults.push([1]);

    await actions.createWorkspaceEnvironment(actionOptions);

    assert.deepEqual(calls, [], change);
    assert.deepEqual(actionOptions.environments.setCalls, [], change);
    assert.deepEqual(vscode.__state.information, [], change);
    assert.match(vscode.__state.errors[0] ?? '', /changed while the action was being prepared/i);
  }
});

test('creation selects only an installed environment with the matching workspace route', async () => {
  const { actions, vscode } = modules();
  for (const mismatch of ['missing route', 'environment', 'project', 'manifest'] as const) {
    reset(vscode);
    const calls: WorkspaceCall[] = [];
    const actionOptions = options(vscode, calls);
    const installed = addInstalledEnvironment(vscode, actionOptions, 'analysis');
    const impostor = { ...installed, envId: { ...installed.envId, id: 'unrelated' } };
    actionOptions.environments.environments.unshift(impostor);
    if (mismatch !== 'missing route') {
      actionOptions.environments.routes.set(impostor, {
        ...actionOptions.environments.routes.get(installed)!,
        environmentName: mismatch === 'environment' ? 'other' : 'analysis',
        projectUri: vscode.Uri.file(mismatch === 'project' ? '/work/other' : '/work/demo'),
        manifestUri: vscode.Uri.file(
          mismatch === 'manifest' ? '/work/demo/pyproject.toml' : '/work/demo/conda.toml',
        ),
      });
    }
    vscode.__state.inputs.push('analysis');
    vscode.__state.quickPickResults.push([0]);

    await actions.createWorkspaceEnvironment(actionOptions);

    assert.deepEqual(
      actionOptions.environments.setCalls,
      [{ scope: vscode.Uri.file('/work/demo'), environment: installed }],
      mismatch,
    );
    assert.deepEqual(vscode.__state.errors, [], mismatch);
  }
});

test('removal uses the selected declaration among multiple environments', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls, undefined, [
    { name: 'default', features: [], installed: true },
    { name: 'docs', features: ['docs'], installed: false },
  ]);
  vscode.__state.quickPickResults.push(1);
  vscode.__state.warningResults.push('Remove Declaration');

  await actions.removeWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, [
    {
      operation: 'remove',
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'docs',
    },
  ]);
  assert.match(vscode.__state.warningCalls[0]?.message ?? '', /docs declaration/);
  assert.deepEqual(vscode.__state.errors, []);
});

test('import rejects unsupported files before asking for a name or changing the workspace', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);

  await actions.importWorkspaceEnvironment(
    actionOptions,
    vscode.Uri.file('/work/requirements.txt'),
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.inputCalls, []);
  assert.match(vscode.__state.errors[0] ?? '', /accepts only environment.yml or environment.yaml/);
});

test('cancelling the feature picker does not create a declaration with default options', async () => {
  const { actions, vscode } = modules();
  reset(vscode);
  const calls: WorkspaceCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.inputs.push('analysis');
  vscode.__state.quickPickResults.push(undefined);

  await actions.createWorkspaceEnvironment(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.information, []);
  assert.deepEqual(vscode.__state.errors, []);
});

test('workspace selection honors the picker and excludes manifests owned only by a parent project', async () => {
  const { actions, vscode } = modules();
  const alpha = vscode.Uri.file('/work/alpha');
  const beta = vscode.Uri.file('/work/beta');
  for (const [selection, expected] of [
    [0, alpha],
    [1, beta],
    [undefined, undefined],
  ] as const) {
    reset(vscode);
    vscode.__state.quickPickResults.push(selection);
    const context = await actions.selectWorkspaceActionContext({
      api: {
        getPythonProject: (uri: VscodeUri) =>
          uri.fsPath.startsWith(alpha.fsPath) ? { uri: alpha } : { uri: beta },
      } as PythonEnvironmentApi,
      environments: {
        getWorkspaceManifests: async () => [
          vscode.Uri.file('/work/beta/conda.toml'),
          vscode.Uri.file('/work/alpha/nested/conda.toml'),
          vscode.Uri.file('/work/alpha/conda.toml'),
        ],
      } as WorkspaceActionEnvironmentManager,
    });

    assert.deepEqual(
      vscode.__state.quickPickCalls[0]?.items.map(({ label }) => label),
      ['alpha', 'beta'],
    );
    assert.equal(context?.projectUri.fsPath, expected?.fsPath);
    assert.deepEqual(vscode.__state.errors, []);
  }
});
