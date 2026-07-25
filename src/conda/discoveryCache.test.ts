import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fingerprintDiscoveryPaths } from './discoveryCache';

test('discovery fingerprints are stable until a watched source changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = path.join(root, 'environments.txt');
  const envsDirectory = path.join(root, 'envs');
  const missing = path.join(root, 'missing');
  await mkdir(envsDirectory);
  await writeFile(registry, 'first\n');

  const paths = [envsDirectory, registry, missing, registry];
  const first = await fingerprintDiscoveryPaths(paths);
  assert.equal(await fingerprintDiscoveryPaths([...paths].reverse()), first);

  await writeFile(registry, 'second and longer\n');
  const fileChanged = await fingerprintDiscoveryPaths(paths);
  assert.notEqual(fileChanged, first);

  await mkdir(path.join(envsDirectory, 'created'));
  const directoryChanged = await fingerprintDiscoveryPaths(paths);
  assert.notEqual(directoryChanged, fileChanged);

  await writeFile(missing, '');
  assert.notEqual(await fingerprintDiscoveryPaths(paths), directoryChanged);
});

test('discovery fingerprints preserve symlink and target changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-fingerprint-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await writeFile(target, 'first\n');
  await symlink(target, link, process.platform === 'win32' ? 'file' : undefined);

  const first = await fingerprintDiscoveryPaths([link]);
  assert.equal(await fingerprintDiscoveryPaths([link]), first);

  await writeFile(target, 'second and longer\n');
  const targetChanged = await fingerprintDiscoveryPaths([link]);
  assert.notEqual(targetChanged, first);

  await rm(target);
  const broken = await fingerprintDiscoveryPaths([link]);
  assert.notEqual(broken, targetChanged);
  assert.equal(await fingerprintDiscoveryPaths([link]), broken);
});
