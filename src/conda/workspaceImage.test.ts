import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import type { LogOutputChannel, Task as VscodeTask, Uri as VscodeUri } from 'vscode';

import type { WorkspaceActionEnvironmentManager, WorkspaceActionOptions } from './workspaceActions';
import type { CondaWorkspaceRoute } from './workspaceRouting';
import type { CondaWorkspacesClient, WorkspaceSnapshot } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-workspace-image-test:vscode';
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

class ProcessExecution {
  constructor(process, args, options) {
    this.process = process;
    this.args = args;
    this.options = options;
  }
}

const TaskScope = { Global: 1, Workspace: 2 };

class Task {
  constructor(definition, scope, name, source, execution, problemMatchers) {
    this.definition = definition;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.problemMatchers = problemMatchers;
  }
}

const __state = {
  errors: [],
  executedTasks: [],
  folders: [],
  information: [],
  inputBoxCalls: [],
  inputBoxResults: [],
  openedDocuments: [],
  quickPickCalls: [],
  quickPickResults: [],
  saveDialogCalls: [],
  saveDialogResult: undefined,
  shownDocuments: [],
};

const workspace = {
  getWorkspaceFolder: (uri) =>
    __state.folders.find((folder) => {
      const relative = path.relative(folder.uri.fsPath, uri.fsPath);
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..');
    }),
  openTextDocument: async (options) => {
    const document = { languageId: options.language, getText: () => options.content };
    __state.openedDocuments.push(document);
    return document;
  },
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
    __state.inputBoxCalls.push(options);
    return __state.inputBoxResults.shift();
  },
  showQuickPick: async (items, options) => {
    __state.quickPickCalls.push({ items, options });
    const result = __state.quickPickResults.shift();
    return result === undefined ? undefined : items[result];
  },
  showSaveDialog: async (options) => {
    __state.saveDialogCalls.push(options);
    return __state.saveDialogResult;
  },
  showTextDocument: async (document) => {
    __state.shownDocuments.push(document);
    return { document };
  },
};

const tasks = {
  executeTask: async (task) => {
    __state.executedTasks.push(task);
    return { task };
  },
};

module.exports = {
  __state,
  ProcessExecution,
  Task,
  TaskScope,
  Uri,
  tasks,
  window,
  workspace,
};
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
    executedTasks: VscodeTask[];
    folders: { readonly uri: VscodeUri; readonly name: string; readonly index: number }[];
    information: string[];
    inputBoxCalls: Record<string, unknown>[];
    inputBoxResults: (string | undefined)[];
    openedDocuments: { readonly languageId: string; getText(): string }[];
    quickPickCalls: {
      readonly items: readonly { readonly label: string; readonly description?: string }[];
      readonly options: Record<string, unknown>;
    }[];
    quickPickResults: (number | undefined)[];
    saveDialogCalls: Record<string, unknown>[];
    saveDialogResult: VscodeUri | undefined;
    shownDocuments: unknown[];
  };
}

interface PreviewCall {
  readonly manifest: string;
  readonly environment: string;
  readonly platform: string;
  readonly options: {
    readonly tag: string;
    readonly command: readonly string[];
    readonly load?: boolean;
    readonly output?: string;
  };
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
  const workspaceImage = requireFromTest('./workspaceImage.js') as {
    previewWorkspaceImage(options: WorkspaceActionOptions): Promise<void>;
    buildWorkspaceImage(options: WorkspaceActionOptions): Promise<void>;
  };
  return { vscode, workspaceImage };
}

function reset(vscode: VscodeStub): void {
  vscode.__state.errors.length = 0;
  vscode.__state.executedTasks.length = 0;
  vscode.__state.folders.length = 0;
  vscode.__state.information.length = 0;
  vscode.__state.inputBoxCalls.length = 0;
  vscode.__state.inputBoxResults.length = 0;
  vscode.__state.openedDocuments.length = 0;
  vscode.__state.quickPickCalls.length = 0;
  vscode.__state.quickPickResults.length = 0;
  vscode.__state.saveDialogCalls.length = 0;
  vscode.__state.saveDialogResult = undefined;
  vscode.__state.shownDocuments.length = 0;
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
      name: 'runtime',
      features: [],
      platforms: ['linux-arm-one', 'linux-arm-two', 'mac'],
      prefix: path.resolve('/work/demo/.conda/envs/runtime'),
      installed: false,
      resolutions: [
        { platform: 'linux-arm-one', subdir: 'linux-aarch64', dependencies: [] },
        { platform: 'linux-arm-two', subdir: 'linux-aarch64', dependencies: [] },
        { platform: 'mac', subdir: 'osx-arm64', dependencies: [] },
      ],
      packages: [],
    },
  ],
): WorkspaceSnapshot {
  return { manifest, name: 'demo', environments };
}

function options(
  vscode: VscodeStub,
  calls: PreviewCall[],
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
    executable: '_conda',
    getWorkspaceInfo: async (manifest: string) => ({ manifest, name: 'demo' }),
    getWorkspaceSnapshot: async (manifest: string) => {
      snapshotCalls.push(manifest);
      return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
    },
    previewWorkspaceImage: async (
      manifest: string,
      environment: string,
      platform: string,
      imageOptions: PreviewCall['options'],
    ) => {
      calls.push({ manifest, environment, platform, options: imageOptions });
      return {
        recipe: 'FROM debian:bookworm-slim\nCMD ["python", "", " spaced "]\n',
        files: ['conda.toml', 'src/app.py'],
      };
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

test('workspace image preview uses an uninstalled named Linux platform and opens recipe and files', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.quickPickResults.push(0, 1);
  vscode.__state.inputBoxResults.push(
    'example:latest',
    'python',
    '["", " spaced ", "--message=hello world"]',
  );

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, [
    {
      manifest: path.resolve('/work/demo/conda.toml'),
      environment: 'runtime',
      platform: 'linux-arm-two',
      options: {
        tag: 'example:latest',
        command: ['python', '', ' spaced ', '--message=hello world'],
        load: true,
      },
    },
  ]);
  assert.deepEqual(
    vscode.__state.quickPickCalls[1]?.items.map(({ label, description }) => ({
      label,
      description,
    })),
    [
      { label: 'linux-arm-one', description: 'Conda subdir: linux-aarch64' },
      { label: 'linux-arm-two', description: 'Conda subdir: linux-aarch64' },
    ],
  );
  assert.equal(actionOptions.environments.refreshCalls.length, 1);
  assert.equal(actionOptions.snapshotCalls.length, 2);
  assert.deepEqual(
    vscode.__state.openedDocuments.map((document) => ({
      languageId: document.languageId,
      text: document.getText(),
    })),
    [
      {
        languageId: 'dockerfile',
        text: 'FROM debian:bookworm-slim\nCMD ["python", "", " spaced "]\n',
      },
      { languageId: 'plaintext', text: 'conda.toml\nsrc/app.py\n' },
    ],
  );
  assert.equal(vscode.__state.shownDocuments.length, 2);
  assert.deepEqual(vscode.__state.errors, []);
});

test('cancelling workspace image command input stops before ownership refresh', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.quickPickResults.push(0, 0);
  vscode.__state.inputBoxResults.push('example:latest', undefined);

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, []);
  assert.deepEqual(actionOptions.environments.refreshCalls, []);
  assert.deepEqual(vscode.__state.errors, []);
});

test('workspace image preview fails closed when ownership changes after selection', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.environments.removeOwnershipOnRefresh = true;
  vscode.__state.quickPickResults.push(0, 0);
  vscode.__state.inputBoxResults.push('example:latest', 'python', '[]');

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /workspace ownership changed/i);
});

test('workspace image preview rejects an environment removed after selection', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls, [snapshot(), snapshot(undefined, [])]);
  vscode.__state.quickPickResults.push(0, 0);
  vscode.__state.inputBoxResults.push('example:latest', 'python', '[]');

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /environment or platform changed/i);
});

test('workspace image preview identifies a backend without snapshot or image support', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  actionOptions.workspaces.getWorkspaceSnapshot = async () => {
    throw new Error('conda workspace: error: unrecognized arguments: --packages');
  };

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /conda-workspaces 0\.10 or newer/);
});

test('workspace image preview reports unsupported backend and backend validation errors', async () => {
  const { vscode, workspaceImage } = modules();
  for (const [backendError, expected] of [
    ['conda workspace: error: invalid choice: image', /conda-workspaces 0\.10 or newer/],
    [
      'Python path, Git, and URL dependencies are not supported for workspace images',
      /Python path, Git, and URL dependencies/,
    ],
  ] as const) {
    reset(vscode);
    const calls: PreviewCall[] = [];
    const actionOptions = options(vscode, calls);
    vscode.__state.quickPickResults.push(0, 0);
    vscode.__state.inputBoxResults.push('example:latest', 'python', '[]');
    (
      actionOptions.workspaces as CondaWorkspacesClient & {
        previewWorkspaceImage: () => Promise<never>;
      }
    ).previewWorkspaceImage = async () => {
      throw new Error(backendError);
    };

    await workspaceImage.previewWorkspaceImage(actionOptions);

    assert.deepEqual(calls, []);
    assert.match(vscode.__state.errors[0] ?? '', expected);
  }
});

test('workspace image build validates through dry-run and starts a cancellable native load task', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  vscode.__state.folders.push({
    uri: vscode.Uri.file('/work/demo'),
    name: 'demo',
    index: 0,
  });
  vscode.__state.quickPickResults.push(0, 1, 0);
  vscode.__state.inputBoxResults.push('example:latest', 'python', '["", " spaced "]');

  await workspaceImage.buildWorkspaceImage(actionOptions);

  assert.deepEqual(calls[0], {
    manifest: path.resolve('/work/demo/conda.toml'),
    environment: 'runtime',
    platform: 'linux-arm-two',
    options: {
      tag: 'example:latest',
      command: ['python', '', ' spaced '],
      load: true,
    },
  });
  assert.equal(vscode.__state.executedTasks.length, 1);
  const task = vscode.__state.executedTasks[0];
  assert.equal(task?.name, 'Build example:latest');
  assert.equal(task?.execution && 'process' in task.execution && task.execution.process, '_conda');
  assert.deepEqual(task?.execution && 'args' in task.execution && task.execution.args, [
    'workspace',
    '--file',
    path.resolve('/work/demo/conda.toml'),
    'image',
    '-e',
    'runtime',
    '--platform',
    'linux-arm-two',
    '--tag',
    'example:latest',
    '--load',
    '--',
    'python',
    '',
    ' spaced ',
  ]);
});

test('workspace image build can export an OCI archive without registry push', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls);
  const destination = vscode.Uri.file('/work/demo/example.oci.tar');
  vscode.__state.quickPickResults.push(0, 0, 1);
  vscode.__state.inputBoxResults.push('example:v1', 'python', '["app.py"]');
  vscode.__state.saveDialogResult = destination;

  await workspaceImage.buildWorkspaceImage(actionOptions);

  assert.deepEqual(calls[0]?.options, {
    tag: 'example:v1',
    command: ['python', 'app.py'],
    output: destination.fsPath,
  });
  const task = vscode.__state.executedTasks[0];
  assert.deepEqual(task?.execution && 'args' in task.execution && task.execution.args, [
    'workspace',
    '--file',
    path.resolve('/work/demo/conda.toml'),
    'image',
    '-e',
    'runtime',
    '--platform',
    'linux-arm-one',
    '--tag',
    'example:v1',
    '--output',
    destination.fsPath,
    '--',
    'python',
    'app.py',
  ]);
});

test('workspace image action rejects declarations without a Linux resolution', async () => {
  const { vscode, workspaceImage } = modules();
  reset(vscode);
  const calls: PreviewCall[] = [];
  const actionOptions = options(vscode, calls, [
    snapshot(undefined, [
      {
        name: 'runtime',
        features: [],
        platforms: ['mac'],
        prefix: path.resolve('/work/demo/.conda/envs/runtime'),
        installed: false,
        resolutions: [{ platform: 'mac', subdir: 'osx-arm64', dependencies: [] }],
        packages: [],
      },
    ]),
  ]);
  vscode.__state.quickPickResults.push(0);

  await workspaceImage.previewWorkspaceImage(actionOptions);

  assert.deepEqual(calls, []);
  assert.match(vscode.__state.errors[0] ?? '', /linux-64 or linux-aarch64/);
});
