import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';

import type {
  EnvironmentManager,
  Package,
  PackageInfo,
  PackageManager,
  PythonEnvironment,
  PythonEnvironmentApi,
  PythonEnvironmentInfo,
} from '@vscode/python-environments';
import type { Uri as VscodeUri } from 'vscode';

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

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base;
    this.pattern = pattern;
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

const ProgressLocation = { Notification: 15 };

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
  showWarningMessage: async (_message, _options, ...items) => items[0],
  withProgress: async (_options, task) =>
    task({ report: () => undefined }),
};

module.exports = {
  __state,
  Disposable,
  EventEmitter,
  ProgressLocation,
  RelativePattern,
  ThemeIcon,
  Uri,
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
export const requireFromTest = createRequire(__filename);

export interface VscodeStub {
  readonly Uri: {
    file(value: string): VscodeUri;
  };
  readonly __state: {
    files: VscodeUri[];
    folders: { readonly uri: VscodeUri }[];
  };
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function pythonApi(projects: readonly VscodeUri[]): PythonEnvironmentApi {
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
