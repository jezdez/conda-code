import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import type { LogOutputChannel, Uri as VscodeUri } from 'vscode';

import type { CondaClient } from './conda';
import type { CondaWorkspaceRoute, CondaWorkspaceRouteManager } from './workspaceRouting';

const VSCODE_STUB_URL = 'conda-code-sbom-test:vscode';
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
  static joinPath(base, ...parts) {
    return Uri.file(path.join(base.fsPath, ...parts));
  }
}

const __state = {
  destination: undefined,
  errors: [],
  folder: undefined,
  information: [],
  progress: [],
  saveDialogs: [],
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
  showSaveDialog: async (options) => {
    __state.saveDialogs.push(options);
    return __state.destination;
  },
  withProgress: async (options, task) => {
    __state.progress.push(options);
    return task({ report: () => undefined });
  },
};

const ProgressLocation = { Notification: 15 };
const workspace = {
  getWorkspaceFolder: () =>
    __state.folder === undefined ? undefined : { uri: __state.folder },
  get workspaceFolders() {
    return __state.folder === undefined ? undefined : [{ uri: __state.folder }];
  },
};

module.exports = { __state, ProgressLocation, Uri, window, workspace };
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
    folder: VscodeUri | undefined;
    information: string[];
    progress: { readonly location: number; readonly title: string }[];
    saveDialogs: {
      readonly defaultUri: VscodeUri;
      readonly filters: Record<string, readonly string[]>;
      readonly saveLabel: string;
    }[];
  };
}

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const sbom = requireFromTest('./sbom.js') as typeof import('./sbom.js');
  return { sbom, vscode };
}

function environment(vscode: VscodeStub, managerId = 'jezdez.conda-code:conda') {
  const prefix = path.resolve('/opt/conda/envs/demo');
  return {
    envId: { id: prefix, managerId },
    environmentPath: vscode.Uri.file(prefix),
    displayName: 'demo',
    name: 'demo',
  } as PythonEnvironment;
}

function apiFor(
  selected: PythonEnvironment | undefined,
  scopes: (VscodeUri | undefined)[],
): PythonEnvironmentApi {
  return {
    getEnvironment: async (scope) => {
      scopes.push(scope);
      return selected;
    },
  } as PythonEnvironmentApi;
}

function routesFor(
  ownerExecutable: string | undefined,
  route?: CondaWorkspaceRoute,
): CondaWorkspaceRouteManager {
  return {
    getCondaExecutableForPrefix: () => ownerExecutable,
    getRoute: () => route,
  } as unknown as CondaWorkspaceRouteManager;
}

function condaClient(calls: { executable: string; prefix: string; file: string }[]): CondaClient {
  return {
    executable: '/configured/bin/conda',
    forExecutable: (executable: string) =>
      ({
        exportEnvironmentSbom: async (prefix: string, file: string) => {
          calls.push({ executable, prefix, file });
        },
      }) as CondaClient,
  } as CondaClient;
}

test('selected environment SBOM export uses the active scope and regular environment owner', async () => {
  const { sbom, vscode } = modules();
  const selected = environment(vscode);
  const scope = vscode.Uri.file('/work/demo/main.py');
  const destination = vscode.Uri.file('/work/demo/demo.cdx.json');
  const scopes: (VscodeUri | undefined)[] = [];
  const calls: { executable: string; prefix: string; file: string }[] = [];
  vscode.__state.destination = destination;
  vscode.__state.errors.length = 0;
  vscode.__state.folder = vscode.Uri.file('/work/demo');
  vscode.__state.information.length = 0;
  vscode.__state.progress.length = 0;
  vscode.__state.saveDialogs.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: apiFor(selected, scopes),
    conda: condaClient(calls),
    environments: routesFor('/owner/bin/conda'),
    managerId: 'jezdez.conda-code:conda',
    scope,
  });

  assert.deepEqual(scopes, [scope]);
  assert.deepEqual(calls, [
    {
      executable: '/owner/bin/conda',
      prefix: selected.environmentPath.fsPath,
      file: destination.fsPath,
    },
  ]);
  assert.deepEqual(vscode.__state.saveDialogs, [
    {
      defaultUri: vscode.Uri.file('/work/demo/demo.cdx.json'),
      filters: { 'CycloneDX JSON': ['json'] },
      saveLabel: 'Export SBOM',
    },
  ]);
  assert.deepEqual(vscode.__state.progress, [
    { location: 15, title: 'Exporting an SBOM for demo' },
  ]);
  assert.deepEqual(vscode.__state.information, [
    `Exported an SBOM for demo to ${destination.fsPath}.`,
  ]);
  assert.deepEqual(vscode.__state.errors, []);
});

test('SBOM export rejects a selection owned by another environment manager', async () => {
  const { sbom, vscode } = modules();
  const calls: { executable: string; prefix: string; file: string }[] = [];
  vscode.__state.errors.length = 0;
  vscode.__state.saveDialogs.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: apiFor(environment(vscode, 'other:manager'), []),
    conda: condaClient(calls),
    environments: routesFor('/owner/bin/conda'),
    managerId: 'jezdez.conda-code:conda',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(vscode.__state.saveDialogs, []);
  assert.deepEqual(vscode.__state.errors, [
    'Select a Conda Code environment for the active scope first.',
  ]);
});

test('SBOM export reports environment selection failures', async () => {
  const { sbom, vscode } = modules();
  const calls: { executable: string; prefix: string; file: string }[] = [];
  const logged: string[] = [];
  vscode.__state.errors.length = 0;
  vscode.__state.saveDialogs.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: {
      getEnvironment: async () => {
        throw new Error('environment refresh failed');
      },
    } as unknown as PythonEnvironmentApi,
    conda: condaClient(calls),
    environments: routesFor('/owner/bin/conda'),
    log: {
      error: (message: string) => {
        logged.push(message);
      },
    } as unknown as LogOutputChannel,
    managerId: 'jezdez.conda-code:conda',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(vscode.__state.saveDialogs, []);
  assert.deepEqual(logged, ['SBOM export failed: environment refresh failed']);
  assert.deepEqual(vscode.__state.errors, [
    'Could not export the environment SBOM: environment refresh failed',
  ]);
});

test('workspace SBOM export uses the configured primary conda executable', async () => {
  const { sbom, vscode } = modules();
  const selected = environment(vscode);
  const calls: { executable: string; prefix: string; file: string }[] = [];
  vscode.__state.destination = vscode.Uri.file('/work/demo.cdx.json');
  vscode.__state.errors.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: apiFor(selected, []),
    conda: condaClient(calls),
    environments: routesFor(undefined, {} as CondaWorkspaceRoute),
    managerId: 'jezdez.conda-code:conda',
  });

  assert.equal(calls[0]?.executable, '/configured/bin/conda');
  assert.deepEqual(vscode.__state.errors, []);
});

test('SBOM export fails closed when a regular environment owner is unknown', async () => {
  const { sbom, vscode } = modules();
  const selected = environment(vscode);
  const calls: { executable: string; prefix: string; file: string }[] = [];
  vscode.__state.destination = vscode.Uri.file('/work/demo.cdx.json');
  vscode.__state.errors.length = 0;
  vscode.__state.saveDialogs.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: apiFor(selected, []),
    conda: condaClient(calls),
    environments: routesFor(undefined),
    managerId: 'jezdez.conda-code:conda',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(vscode.__state.saveDialogs, []);
  assert.deepEqual(vscode.__state.errors, [
    `Conda Code does not know which conda installation owns ${selected.environmentPath.fsPath}.`,
  ]);
});

test('cancelling the SBOM save dialog does not run conda', async () => {
  const { sbom, vscode } = modules();
  const calls: { executable: string; prefix: string; file: string }[] = [];
  vscode.__state.destination = undefined;
  vscode.__state.errors.length = 0;
  vscode.__state.information.length = 0;
  vscode.__state.progress.length = 0;

  await sbom.exportSelectedEnvironmentSbom({
    api: apiFor(environment(vscode), []),
    conda: condaClient(calls),
    environments: routesFor('/owner/bin/conda'),
    managerId: 'jezdez.conda-code:conda',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(vscode.__state.progress, []);
  assert.deepEqual(vscode.__state.information, []);
  assert.deepEqual(vscode.__state.errors, []);
});
