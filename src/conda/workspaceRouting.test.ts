import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { PythonEnvironment } from '@vscode/python-environments';
import type { Memento, Uri } from 'vscode';

import { CondaWorkspaceSelectionState } from './selectionState';
import {
  CompositeWorkspaceEnvironmentError,
  CondaWorkspaceRoute,
  CondaWorkspaceRouteRegistry,
  dependencyFeature,
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
      managerId: 'jezdez.conda-code:conda-workspaces',
    },
  } as PythonEnvironment;
  assert.equal(registry.getRoute(environment), route);
  assert.equal(registry.getRouteByContext(uri(route.pythonPath)), route);

  registry.replaceProject(project, []);
  assert.equal(registry.getRoute(environment), undefined);
});

test('dependency feature routing is deterministic and rejects composites', () => {
  assert.equal(dependencyFeature('default', []), undefined);
  assert.equal(dependencyFeature('test', ['test']), 'test');
  assert.throws(
    () => dependencyFeature('test-py312', ['test', 'py312']),
    CompositeWorkspaceEnvironmentError,
  );
});
