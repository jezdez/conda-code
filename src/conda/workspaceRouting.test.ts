import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment } from '@vscode/python-environments';
import type { Memento, Uri } from 'vscode';

import { CondaSelectionState, CondaWorkspaceSelectionState } from './selectionState';
import {
  CompositeWorkspaceEnvironmentError,
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

test('selection state persists only project environment prefixes', async () => {
  const state = memory();
  const project = uri('/work/demo');
  const selections = new CondaWorkspaceSelectionState(state);

  await selections.set(project, '/work/demo/.conda/envs/default');
  assert.equal(
    await new CondaWorkspaceSelectionState(state).get(project),
    '/work/demo/.conda/envs/default',
  );

  await selections.set(project, undefined);
  assert.equal(await selections.get(project), undefined);
});

test('general selection state supports global and project selections', async () => {
  const state = memory();
  const project = uri('/work/demo');
  const selections = new CondaSelectionState(state);

  await selections.set(undefined, '/opt/conda');
  await selections.set(project, '/opt/conda/envs/demo');

  assert.equal(await selections.get(undefined), '/opt/conda');
  assert.equal(await selections.get(project), '/opt/conda/envs/demo');
  assert.deepEqual(await selections.entries(), {
    global: '/opt/conda',
    [project.toString(true)]: '/opt/conda/envs/demo',
  });
});

test('route registry resolves prefixes and Python executables privately', () => {
  const registry = new CondaWorkspaceRouteRegistry();
  const project = uri('/work/demo');
  const route: CondaWorkspaceRoute = {
    projectUri: project,
    manifestUri: uri('/work/demo/conda.toml'),
    environmentName: 'default',
    features: [],
    directCondaDependencies: ['python'],
    prefix: path.resolve('/work/demo/.conda/envs/default'),
    pythonPath: path.resolve('/work/demo/.conda/envs/default/bin/python'),
  };
  registry.replaceProject(project, [route]);

  const environment = {
    environmentPath: uri(route.prefix),
    envId: {
      id: route.prefix,
      managerId: 'jezdez.conda-code:conda',
    },
  } as PythonEnvironment;
  assert.equal(registry.getRoute(environment), route);
  assert.equal(registry.getRouteByContext(uri(route.pythonPath)), route);

  registry.replaceProject(project, []);
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
    directCondaDependencies: ['python'],
    prefix: sharedPrefix,
    pythonPath: path.join(sharedPrefix, 'bin', 'python'),
  };
  const second: CondaWorkspaceRoute = {
    ...first,
    projectUri: uri('/work/second'),
    manifestUri: uri('/work/second/conda.toml'),
  };

  registry.replaceAll([first, second]);
  assert.equal(registry.getRouteByPrefix(sharedPrefix), undefined);
  assert.equal(registry.isConflictedPrefix(sharedPrefix), true);

  registry.replaceAll([first]);
  assert.equal(registry.getRouteByPrefix(sharedPrefix), first);
  assert.equal(registry.isConflictedPrefix(sharedPrefix), false);
});

test('failed workspace discovery preserves its previous prefix claim', () => {
  const manifest = '/work/demo/conda.toml';
  const route: CondaWorkspaceRoute = {
    projectUri: uri('/work/demo'),
    manifestUri: uri(manifest),
    environmentName: 'default',
    features: [],
    directCondaDependencies: ['python'],
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
    directCondaDependencies: ['python'],
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
  assert.equal(registry.getRouteByPrefix(sharedPrefix), undefined);
});

test('dependency feature routing is deterministic and rejects composites', () => {
  assert.equal(dependencyFeature('default', []), undefined);
  assert.equal(dependencyFeature('test', ['test']), 'test');
  assert.throws(
    () => dependencyFeature('test-py312', ['test', 'py312']),
    CompositeWorkspaceEnvironmentError,
  );
});
