import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

import type { PythonEnvironmentApi, PythonProject } from '@vscode/python-environments';
import type { Uri as VscodeUri } from 'vscode';

import type { CondaWorkspacesClient } from './workspaces';

const VSCODE_STUB_URL = 'conda-code-test:projects-vscode';
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

const __state = {
  files: [],
  fileContents: new Map(),
  informationMessages: [],
  quickPickSelection: undefined,
  quickPicks: [],
};

const window = {
  showInformationMessage: async (message) => {
    __state.informationMessages.push(message);
  },
  showQuickPick: async (items, options) => {
    __state.quickPicks.push({ items, options });
    return __state.quickPickSelection?.map((index) => items[index]);
  },
  withProgress: async (_options, task) => task({ report: () => undefined }),
};

const workspace = {
  findFiles: async () => __state.files,
  fs: {
    readFile: async (uri) => Buffer.from(__state.fileContents.get(uri.fsPath) ?? ''),
  },
};

module.exports = { __state, ProgressLocation: { Notification: 15 }, Uri, window, workspace };
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

interface ProjectCandidate {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly manifest: VscodeUri;
}

interface VscodeStub {
  readonly Uri: {
    file(value: string): VscodeUri;
  };
  readonly __state: {
    files: VscodeUri[];
    fileContents: Map<string, string>;
    informationMessages: string[];
    quickPickSelection: number[] | undefined;
    quickPicks: {
      readonly items: readonly ProjectCandidate[];
      readonly options: Record<string, unknown>;
    }[];
  };
}

const requireFromTest = createRequire(__filename);

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const projects = requireFromTest('./projects.js') as typeof import('./projects.js');
  return { vscode, projects };
}

function pythonApi(
  registered: readonly PythonProject[],
  additions: PythonProject[][],
): PythonEnvironmentApi {
  return {
    getPythonProjects: () => registered,
    addPythonProject: (projects: PythonProject | PythonProject[]) => {
      additions.push(Array.isArray(projects) ? projects : [projects]);
    },
  } as unknown as PythonEnvironmentApi;
}

test('offers only owned, unregistered workspace roots', async () => {
  const { vscode, projects } = modules();
  const manifest = (value: string) => vscode.Uri.file(value);
  vscode.__state.files = [
    manifest('/work/plain/pyproject.toml'),
    manifest('/work/registered/conda.toml'),
    manifest('/work/alpha/pyproject.toml'),
    manifest('/work/unowned/conda.toml'),
    manifest('/work/alpha/pixi.toml'),
    manifest('/work/registered/nested/conda.toml'),
    manifest('/work/beta/pyproject.toml'),
    manifest('/work/alpha/conda.toml'),
  ];
  vscode.__state.fileContents = new Map([
    [path.resolve('/work/plain/pyproject.toml'), '[project]'],
    [path.resolve('/work/alpha/pyproject.toml'), '[tool.conda]'],
    [path.resolve('/work/beta/pyproject.toml'), '[ tool . pixi . dependencies ]'],
  ]);
  vscode.__state.quickPickSelection = undefined;
  vscode.__state.quickPicks.length = 0;
  const additions: PythonProject[][] = [];
  let validationCalls = 0;
  const finder = new projects.CondaWorkspaceProjectFinder(
    pythonApi([{ name: 'registered', uri: vscode.Uri.file('/work/registered') }], additions),
    {
      getWorkspaceInfo: async () => {
        validationCalls += 1;
        throw new Error('cancelled candidates must not be validated');
      },
    } as unknown as CondaWorkspacesClient,
    {
      shouldHandleManifest: (candidate) =>
        path.basename(path.dirname(candidate.fsPath)) !== 'unowned',
    },
  );

  const result = await finder.create();

  assert.equal(result, undefined);
  assert.equal(validationCalls, 0);
  assert.deepEqual(additions, []);
  assert.equal(vscode.__state.quickPicks.length, 1);
  assert.deepEqual(
    vscode.__state.quickPicks[0]?.items.map(({ label, description, detail }) => ({
      label,
      description,
      detail,
    })),
    [
      { label: 'alpha', description: path.resolve('/work/alpha'), detail: 'conda.toml' },
      { label: 'beta', description: path.resolve('/work/beta'), detail: 'pyproject.toml' },
      {
        label: 'nested',
        description: path.resolve('/work/registered/nested'),
        detail: 'conda.toml',
      },
    ],
  );
});

test('validates and adds only selected projects', async () => {
  const { vscode, projects } = modules();
  const alpha = vscode.Uri.file('/work/alpha/conda.toml');
  const beta = vscode.Uri.file('/work/beta/conda.toml');
  const broken = vscode.Uri.file('/work/broken/conda.toml');
  vscode.__state.files = [broken, alpha, beta];
  vscode.__state.quickPickSelection = [1, 2];
  vscode.__state.quickPicks.length = 0;
  const additions: PythonProject[][] = [];
  const validated: string[] = [];
  const finder = new projects.CondaWorkspaceProjectFinder(pythonApi([], additions), {
    getWorkspaceInfo: async (selected: string) => {
      validated.push(selected);
      if (selected === broken.fsPath) {
        throw new Error('invalid workspace');
      }
      return { manifest: selected, name: 'beta-workspace' };
    },
  } as unknown as CondaWorkspacesClient);

  const result = await finder.create();

  assert.deepEqual(validated, [beta.fsPath, broken.fsPath]);
  assert.deepEqual(result, [
    {
      name: 'beta-workspace',
      uri: vscode.Uri.file('/work/beta'),
      description: 'workspace',
      tooltip: beta.fsPath,
    },
  ]);
  assert.deepEqual(additions, [result]);
});
