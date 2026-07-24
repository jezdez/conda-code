import assert from 'node:assert/strict';
import test from 'node:test';

import type { Package, PythonEnvironment } from '@vscode/python-environments';

import { diffEnvironments, diffPackages } from './changes';

function environment(id: string): PythonEnvironment {
  return {
    envId: { id, managerId: 'jezdez.conda-code:conda' },
  } as PythonEnvironment;
}

function pkg(
  name: string,
  version: string,
  build: string,
  dependencyKind = 'Direct dependency',
): Package {
  return {
    name,
    displayName: name,
    version,
    description: `Build ${build}, ${dependencyKind}`,
    pkgId: {
      id: name,
      managerId: 'jezdez.conda-code:conda',
      environmentId: '/workspace/.conda/envs/default',
    },
  } as Package;
}

test('diffEnvironments reports environment ID additions and removals', () => {
  const retained = environment('/envs/retained');
  const removed = environment('/envs/removed');
  const added = environment('/envs/added');

  assert.deepEqual(diffEnvironments([retained, removed], [retained, added]), [
    { kind: 'remove', environment: removed },
    { kind: 'add', environment: added },
  ]);
});

test('diffPackages reports direct dependency classification changes', () => {
  const before = pkg('numpy', '2.3.1', 'py313_1', 'Transitive dependency');
  const after = pkg('numpy', '2.3.1', 'py313_1');

  assert.deepEqual(diffPackages([before], [after]), [
    { kind: 'remove', pkg: before },
    { kind: 'add', pkg: after },
  ]);
});

test('diffPackages treats version and build changes as remove then add', () => {
  const retained = pkg('python', '3.13.5', 'h1_0');
  const before = pkg('numpy', '2.3.0', 'py313_0');
  const after = pkg('numpy', '2.3.1', 'py313_1');

  assert.deepEqual(diffPackages([retained, before], [retained, after]), [
    { kind: 'remove', pkg: before },
    { kind: 'add', pkg: after },
  ]);
});
