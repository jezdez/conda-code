import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { CancellationToken, Task as VscodeTask, Uri as VscodeUri } from 'vscode';

import type { CondaWorkspacesClient, WorkspaceTaskList } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-tasks-test:vscode';
const VSCODE_STUB_SOURCE = String.raw`
const path = require('node:path');

class Uri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = fsPath;
  }
  static file(value) {
    return new Uri(path.resolve(value));
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
    this.problemMatchers =
      problemMatchers === undefined
        ? undefined
        : Array.isArray(problemMatchers)
          ? problemMatchers
          : [problemMatchers];
    this.isBackground = false;
    this.presentationOptions = {};
    this.runOptions = {};
  }
}

const __state = {
  files: [],
  folders: [],
  quickPickIndex: undefined,
  quickPickCalls: [],
  messages: [],
  executedTasks: [],
};
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
  get workspaceFolders() {
    return __state.folders;
  },
};

const window = {
  showInformationMessage: async (message) => {
    __state.messages.push(message);
    return undefined;
  },
  showQuickPick: async (items, options) => {
    __state.quickPickCalls.push({ items, options });
    return __state.quickPickIndex === undefined ? undefined : items[__state.quickPickIndex];
  },
};

const tasks = {
  executeTask: async (task) => {
    __state.executedTasks.push(task);
    return { task };
  },
};

module.exports = { __state, EventEmitter, ProcessExecution, Task, TaskScope, Uri, tasks, window, workspace };
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
  readonly Task: new (
    definition: Record<string, unknown>,
    scope: unknown,
    name: string,
    source: string,
  ) => VscodeTask;
  readonly __state: {
    files: VscodeUri[];
    folders: {
      readonly uri: VscodeUri;
      readonly name: string;
      readonly index: number;
    }[];
    quickPickIndex: number | undefined;
    quickPickCalls: {
      readonly items: readonly { readonly label: string; readonly description?: string }[];
      readonly options: Record<string, unknown>;
    }[];
    messages: string[];
    executedTasks: VscodeTask[];
  };
}

function cancellationToken(): CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const tasks = requireFromTest('./tasks.js') as typeof import('./tasks.js');
  return { vscode, tasks };
}

function workspaceClient(
  listTasks: (manifest: string) => Promise<WorkspaceTaskList>,
): CondaWorkspacesClient {
  return { listTasks } as CondaWorkspacesClient;
}

test('provider rejects a non-conda task executable', () => {
  const { tasks } = modules();

  for (const executable of ['/custom/solver', 'C:\\Miniforge3\\condabin\\conda.bat']) {
    assert.throws(
      () =>
        new tasks.CondaWorkspaceTaskProvider(
          workspaceClient(async (file) => ({ file, tasks: [] })),
          executable,
          { listWorkspaceManifests: async () => [] },
        ),
      /must invoke conda/,
    );
  }
});

test('provider discovers native tasks only for confirmed workspace manifests', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const folder = { uri: vscode.Uri.file(root), name: 'work', index: 0 };
  const condaManifest = vscode.Uri.file(path.join(root, 'project', 'conda.toml'));
  vscode.__state.files = [condaManifest];
  vscode.__state.folders = [folder];
  const calls: string[] = [];
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async (manifest) => {
      calls.push(manifest);
      return {
        file: manifest,
        tasks: [
          { name: 'docs', description: 'Build documentation' },
          { name: 'global-check', source: 'user' },
        ],
      };
    }),
    '_conda',
    {
      listWorkspaceManifests: async () => [condaManifest],
      selectedWorkspaceEnvironment: async () => 'dev',
    },
  );
  t.after(() => provider.dispose());

  const detected = await provider.provideTasks(cancellationToken());

  assert.deepEqual(calls, [condaManifest.fsPath]);
  assert.equal(detected.length, 1);
  const task = detected[0];
  assert.deepEqual(task?.definition, {
    type: tasks.CONDA_WORKSPACE_TASK_TYPE,
    task: 'docs',
    file: 'project/conda.toml',
  });
  assert.equal(task?.scope, folder);
  assert.equal(task?.source, 'conda-workspaces');
  assert.equal(task?.detail, 'Build documentation (project/conda.toml)');
  assert.deepEqual(task?.problemMatchers, []);
  assert.equal(task?.execution && 'process' in task.execution && task.execution.process, '_conda');
  assert.deepEqual(task?.execution && 'args' in task.execution && task.execution.args, [
    'task',
    '--file',
    condaManifest.fsPath,
    'run',
    '--environment=dev',
    '--',
    'docs',
  ]);
  assert.deepEqual(task?.execution && 'options' in task.execution && task.execution.options, {
    cwd: path.dirname(condaManifest.fsPath),
  });
});

test('provider lists tasks for only the requested confirmed manifest', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const folder = { uri: vscode.Uri.file(root), name: 'work', index: 0 };
  const firstManifest = vscode.Uri.file(path.join(root, 'first', 'conda.toml'));
  const secondManifest = vscode.Uri.file(path.join(root, 'second', 'pyproject.toml'));
  vscode.__state.folders = [folder];
  const calls: string[] = [];
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async (manifest) => {
      calls.push(manifest);
      return {
        file: manifest,
        tasks: [
          { name: 'check', description: 'Check the project' },
          { name: 'user-check', source: 'user' },
        ],
      };
    }),
    'conda',
    {
      listWorkspaceManifests: async () => [firstManifest, secondManifest],
      selectedWorkspaceEnvironment: async () => 'dev',
    },
  );
  t.after(() => provider.dispose());

  const detected = await provider.provideTasksForManifest(secondManifest);

  assert.deepEqual(calls, [secondManifest.fsPath]);
  assert.equal(detected?.length, 1);
  assert.deepEqual(detected?.[0]?.definition, {
    type: tasks.CONDA_WORKSPACE_TASK_TYPE,
    task: 'check',
    file: 'second/pyproject.toml',
  });
  assert.deepEqual(
    detected?.[0]?.execution && 'args' in detected[0].execution && detected[0].execution.args,
    ['task', '--file', secondManifest.fsPath, 'run', '--environment=dev', '--', 'check'],
  );
});

test('run workspace task selects and executes a task from the active manifest', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const manifest = vscode.Uri.file(path.join(root, 'conda.toml'));
  vscode.__state.folders = [{ uri: vscode.Uri.file(root), name: 'work', index: 0 }];
  vscode.__state.quickPickIndex = 1;
  vscode.__state.quickPickCalls = [];
  vscode.__state.messages = [];
  vscode.__state.executedTasks = [];
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async (file) => ({
      file,
      tasks: [
        { name: 'check', description: 'Check the project' },
        { name: 'docs', description: 'Build the docs' },
      ],
    })),
    'conda',
    { listWorkspaceManifests: async () => [manifest] },
  );
  t.after(() => provider.dispose());

  await tasks.runWorkspaceTask(provider, manifest);

  assert.deepEqual(
    vscode.__state.quickPickCalls[0]?.items.map(({ label, description }) => ({
      label,
      description,
    })),
    [
      { label: 'check', description: 'Check the project (conda.toml)' },
      { label: 'docs', description: 'Build the docs (conda.toml)' },
    ],
  );
  assert.equal(vscode.__state.executedTasks.length, 1);
  assert.equal(vscode.__state.executedTasks[0]?.name, 'docs');
  assert.deepEqual(vscode.__state.messages, []);
});

test('run workspace task refuses an unconfirmed manifest', async (t) => {
  const { vscode, tasks } = modules();
  const manifest = vscode.Uri.file(path.resolve('/work/pyproject.toml'));
  vscode.__state.quickPickIndex = 0;
  vscode.__state.quickPickCalls = [];
  vscode.__state.messages = [];
  vscode.__state.executedTasks = [];
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async () => {
      throw new Error('an unconfirmed manifest must not be inspected');
    }),
    'conda',
    { listWorkspaceManifests: async () => [] },
  );
  t.after(() => provider.dispose());

  await tasks.runWorkspaceTask(provider, manifest);

  assert.deepEqual(vscode.__state.messages, [
    'The active file is not a workspace manifest managed by Conda Code.',
  ]);
  assert.deepEqual(vscode.__state.quickPickCalls, []);
  assert.deepEqual(vscode.__state.executedTasks, []);
});

test('provideTasks coalesces discovery and caches it until refresh', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const manifest = vscode.Uri.file(path.join(root, 'conda.toml'));
  vscode.__state.files = [manifest];
  vscode.__state.folders = [{ uri: vscode.Uri.file(root), name: 'work', index: 0 }];
  let calls = 0;
  let selectedEnvironment: string | undefined;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async (file) => {
      calls += 1;
      await gate;
      return { file, tasks: [{ name: 'test' }] };
    }),
    'conda',
    {
      listWorkspaceManifests: async () => [manifest],
      selectedWorkspaceEnvironment: async () => selectedEnvironment,
    },
  );
  t.after(() => provider.dispose());

  const first = provider.provideTasks(cancellationToken());
  const concurrent = provider.provideTasks(cancellationToken());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();
  const firstTasks = await first;
  assert.equal(firstTasks.length, 1);
  assert.deepEqual(
    firstTasks[0]?.execution && 'args' in firstTasks[0].execution && firstTasks[0].execution.args,
    ['task', '--file', manifest.fsPath, 'run', '--', 'test'],
  );
  assert.equal((await concurrent).length, 1);

  selectedEnvironment = 'dev';
  const cachedTasks = await provider.provideTasks(cancellationToken());
  assert.deepEqual(
    cachedTasks[0]?.execution &&
      'args' in cachedTasks[0].execution &&
      cachedTasks[0].execution.args,
    ['task', '--file', manifest.fsPath, 'run', '--environment=dev', '--', 'test'],
  );
  selectedEnvironment = 'test';
  const retargetedTasks = await provider.provideTasks(cancellationToken());
  assert.deepEqual(
    retargetedTasks[0]?.execution &&
      'args' in retargetedTasks[0].execution &&
      retargetedTasks[0].execution.args,
    ['task', '--file', manifest.fsPath, 'run', '--environment=test', '--', 'test'],
  );
  assert.equal(calls, 1);

  provider.refresh();
  assert.equal((await provider.provideTasks(cancellationToken())).length, 1);
  assert.equal(calls, 2);
});

test('provider inspects registered manifests sequentially', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const firstManifest = vscode.Uri.file(path.join(root, 'first', 'conda.toml'));
  const secondManifest = vscode.Uri.file(path.join(root, 'second', 'conda.toml'));
  vscode.__state.files = [secondManifest, firstManifest];
  vscode.__state.folders = [{ uri: vscode.Uri.file(root), name: 'work', index: 0 }];
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async (file) => {
      calls.push(file);
      if (file === firstManifest.fsPath) {
        await firstGate;
      }
      return { file, tasks: [] };
    }),
    'conda',
    {
      listWorkspaceManifests: async () => [firstManifest, secondManifest],
    },
  );
  t.after(() => provider.dispose());

  const discovery = provider.provideTasks(cancellationToken());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [firstManifest.fsPath]);

  releaseFirst?.();
  await discovery;
  assert.deepEqual(calls, [firstManifest.fsPath, secondManifest.fsPath]);
});

test('resolveTask preserves its definition and resolves the manifest against its folder', async (t) => {
  const { vscode, tasks } = modules();
  const root = path.resolve('/work');
  const folder = { uri: vscode.Uri.file(root), name: 'work', index: 0 };
  vscode.__state.files = [];
  vscode.__state.folders = [folder];
  const definition = {
    type: tasks.CONDA_WORKSPACE_TASK_TYPE,
    task: '--help',
    file: 'project/conda.toml',
  };
  const unresolved = new vscode.Task(definition, folder, '--help', 'conda-workspaces');
  const provider = new tasks.CondaWorkspaceTaskProvider(
    workspaceClient(async () => {
      throw new Error('resolveTask must not run discovery');
    }),
    '_conda',
    {
      listWorkspaceManifests: async () => [
        vscode.Uri.file(path.join(root, 'project', 'conda.toml')),
      ],
      selectedWorkspaceEnvironment: async () => 'test',
    },
  );
  t.after(() => provider.dispose());

  const resolved = await provider.resolveTask(unresolved, cancellationToken());
  const manifest = path.join(root, 'project', 'conda.toml');

  assert.equal(resolved, unresolved);
  assert.equal(resolved?.definition, definition);
  assert.equal(
    resolved?.execution && 'process' in resolved.execution && resolved.execution.process,
    '_conda',
  );
  assert.deepEqual(resolved?.execution && 'args' in resolved.execution && resolved.execution.args, [
    'task',
    '--file',
    manifest,
    'run',
    '--environment=test',
    '--',
    '--help',
  ]);
  assert.deepEqual(
    resolved?.execution && 'options' in resolved.execution && resolved.execution.options,
    { cwd: path.dirname(manifest) },
  );

  const unconfirmed = new vscode.Task(
    {
      type: tasks.CONDA_WORKSPACE_TASK_TYPE,
      task: 'test',
      file: 'other/conda.toml',
    },
    folder,
    'test',
    'conda-workspaces',
  );
  assert.equal(await provider.resolveTask(unconfirmed, cancellationToken()), undefined);
});
