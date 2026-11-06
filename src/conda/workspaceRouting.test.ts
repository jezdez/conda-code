import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment } from '@vscode/python-environments';
import type { Memento, Uri } from 'vscode';

import { CondaSelectionState } from './selectionState';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteRegistry,
  dependencyFeature,
  reconcileWorkspaceRouteClaims,
} from './workspaceRouting';

function uri(fsPath: string): Uri {
  const absolutePath = path.resolve(fsPath);
  return {
    scheme: 'file',
    fsPath: absolutePath,
    toString: () => `file://${absolutePath}`,
  } as Uri;
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

test('general selection state supports global and project selections', async () => {
  const state = memory();
  const project = uri('/work/demo');
  const selections = new CondaSelectionState(state);

  await selections.set(undefined, '/opt/conda');
  await selections.set(project, '/opt/conda/envs/demo');

  assert.deepEqual(await new CondaSelectionState(state).entries(), {
    global: '/opt/conda',
    [project.toString(true)]: '/opt/conda/envs/demo',
  });

  await selections.set(project, undefined);
  assert.deepEqual(await selections.entries(), { global: '/opt/conda' });
});

test('route registry resolves prefixes and Python executables privately', () => {
  const registry = new CondaWorkspaceRouteRegistry();
  const project = uri('/work/demo');
  const route: CondaWorkspaceRoute = {
    projectUri: project,
    manifestUri: uri('/work/demo/conda.toml'),
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'python', pypi: false }],
    packages: [],
    snapshotAvailable: false,
    prefix: path.resolve('/work/demo/.conda/envs/default'),
    pythonPath: path.resolve('/work/demo/.conda/envs/default/bin/python'),
  };
  registry.replaceAll([route]);

  const environment = {
    environmentPath: uri(route.prefix),
    envId: {
      id: route.prefix,
      managerId: 'jezdez.conda-code:conda',
    },
  } as PythonEnvironment;
  assert.equal(registry.getRoute(environment), route);
  assert.equal(registry.getRouteByContext(uri(route.pythonPath)), route);

  registry.replaceAll([]);
  assert.equal(registry.getRoute(environment), undefined);
});

test('route registry leaves multiply claimed prefixes unowned', () => {
  const registry = new CondaWorkspaceRouteRegistry();
  const sharedPrefix = path.resolve('/shared/env');
  const first: CondaWorkspaceRoute = {
    projectUri: uri('/work/first'),
    manifestUri: uri('/work/first/conda.toml'),
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'python', pypi: false }],
    packages: [],
    snapshotAvailable: false,
    prefix: sharedPrefix,
    pythonPath: path.join(sharedPrefix, 'bin', 'python'),
  };
  const second: CondaWorkspaceRoute = {
    ...first,
    projectUri: uri('/work/second'),
    manifestUri: uri('/work/second/conda.toml'),
  };

  registry.replaceAll([first, second]);
  const environment = {
    environmentPath: uri(sharedPrefix),
  } as PythonEnvironment;
  assert.equal(registry.getRoute(environment), undefined);
  assert.equal(registry.isConflictedPrefix(sharedPrefix), true);

  registry.replaceAll([first]);
  assert.equal(registry.getRoute(environment), first);
  assert.equal(registry.isConflictedPrefix(sharedPrefix), false);
});

test('route registry treats symlink aliases as the same prefix identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-route-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix');
  const alias = path.join(root, 'alias');
  const pythonPath = path.join(prefix, 'bin', 'python');
  await mkdir(path.dirname(pythonPath), { recursive: true });
  await writeFile(pythonPath, '');
  await symlink(prefix, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const first: CondaWorkspaceRoute = {
    projectUri: uri(path.join(root, 'first')),
    manifestUri: uri(path.join(root, 'first', 'conda.toml')),
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'python', pypi: false }],
    packages: [],
    snapshotAvailable: false,
    prefix,
    pythonPath,
  };
  const second: CondaWorkspaceRoute = {
    ...first,
    projectUri: uri(path.join(root, 'second')),
    manifestUri: uri(path.join(root, 'second', 'conda.toml')),
    prefix: alias,
    pythonPath: path.join(alias, 'bin', 'python'),
  };
  const registry = new CondaWorkspaceRouteRegistry();

  registry.replaceAll([first, second]);
  assert.equal(registry.isConflictedPrefix(alias), true);
  assert.equal(registry.getRoute({ environmentPath: uri(prefix) } as PythonEnvironment), undefined);

  registry.replaceAll([first]);
  assert.equal(registry.getRoute({ environmentPath: uri(alias) } as PythonEnvironment), first);
  assert.equal(registry.getRouteByContext(uri(path.join(alias, 'bin', 'python'))), first);
});

test('failed workspace discovery preserves its previous prefix claim', () => {
  const manifest = '/work/demo/conda.toml';
  const route: CondaWorkspaceRoute = {
    projectUri: uri('/work/demo'),
    manifestUri: uri(manifest),
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'python', pypi: false }],
    packages: [],
    snapshotAvailable: false,
    prefix: path.resolve('/work/demo/.conda/envs/default'),
    pythonPath: path.resolve('/work/demo/.conda/envs/default/bin/python'),
  };

  const claims = reconcileWorkspaceRouteClaims(
    new Map(),
    new Set([manifest]),
    new Map([[manifest, [route]]]),
  );

  assert.deepEqual(claims.get(manifest), [route]);
});

test('a failed claimant keeps a shared prefix conflicted', () => {
  const sharedPrefix = path.resolve('/shared/env');
  const firstManifest = '/work/first/conda.toml';
  const secondManifest = '/work/second/conda.toml';
  const first: CondaWorkspaceRoute = {
    projectUri: uri('/work/first'),
    manifestUri: uri(firstManifest),
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'python', pypi: false }],
    packages: [],
    snapshotAvailable: false,
    prefix: sharedPrefix,
    pythonPath: path.join(sharedPrefix, 'bin', 'python'),
  };
  const second: CondaWorkspaceRoute = {
    ...first,
    projectUri: uri('/work/second'),
    manifestUri: uri(secondManifest),
  };
  const claims = reconcileWorkspaceRouteClaims(
    new Map([[secondManifest, [second]]]),
    new Set([firstManifest]),
    new Map([
      [firstManifest, [first]],
      [secondManifest, [second]],
    ]),
  );
  const registry = new CondaWorkspaceRouteRegistry();
  registry.replaceAll([...claims.values()].flat());

  assert.equal(registry.isConflictedPrefix(sharedPrefix), true);
  assert.equal(
    registry.getRoute({ environmentPath: uri(sharedPrefix) } as PythonEnvironment),
    undefined,
  );
});

test('legacy dependency feature routing requires exactly one feature', () => {
  assert.throws(
    () => dependencyFeature('default', []),
    /require exactly one feature.*default uses none/,
  );
  assert.equal(dependencyFeature('test', ['test']), 'test');
  assert.throws(
    () => dependencyFeature('test-py312', ['test', 'py312']),
    /require exactly one feature.*test-py312 uses test, py312/,
  );
});
