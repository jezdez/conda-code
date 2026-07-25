import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  condaInfoCoherenceFingerprint,
  isCachedCondaInfoCoherent,
  isCachedCondaInfoFresh,
  type CachedCondaInfo,
} from './infoCache';
import type { CondaInfo } from './parsers';

const info: CondaInfo = {
  platform: 'osx-arm64',
  rootPrefix: '/opt/conda',
  envsDirs: ['/opt/conda/envs'],
  defaultPrefix: '/opt/conda',
  activePrefix: null,
  envs: ['/opt/conda'],
  envsDetails: {},
};

test('expires cached conda information by age', () => {
  const cached: CachedCondaInfo = {
    executable: 'conda',
    path: '/bin',
    updatedAt: 1_000,
    info,
  };

  assert.equal(isCachedCondaInfoFresh(cached, 1_999, 1_000), true);
  assert.equal(isCachedCondaInfoFresh(cached, 2_000, 1_000), false);
  assert.equal(isCachedCondaInfoFresh({ ...cached, updatedAt: 0 }, 1_001, 1_000), false);
  assert.equal(isCachedCondaInfoFresh({ ...cached, updatedAt: 2_000 }, 1_000, 1_000), false);
  assert.equal(isCachedCondaInfoFresh(undefined, 1_000, 1_000), false);
});

test('fingerprints reported config contents and relevant conda inputs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-info-coherence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, process.platform === 'win32' ? 'conda.exe' : 'conda');
  const config = path.join(root, '.condarc');
  await Promise.all([writeFile(executable, ''), writeFile(config, 'envs_dirs: [one]\n')]);
  const configuredInfo = { ...info, configFiles: [config], rcPath: config };
  const environment = { PATH: root, CONDA_ENVS_PATH: '/one', UNRELATED: 'before' };

  const initial = await condaInfoCoherenceFingerprint(executable, configuredInfo, environment);
  assert.equal(
    initial,
    await condaInfoCoherenceFingerprint(executable, configuredInfo, {
      ...environment,
      UNRELATED: 'after',
    }),
  );

  await writeFile(config, 'envs_dirs: [two]\n');
  const changedConfig = await condaInfoCoherenceFingerprint(
    executable,
    configuredInfo,
    environment,
  );
  assert.notEqual(changedConfig, initial);

  const changedEnvironment = await condaInfoCoherenceFingerprint(executable, configuredInfo, {
    ...environment,
    CONDA_ENVS_PATH: '/two',
  });
  assert.notEqual(changedEnvironment, changedConfig);
  assert.equal(
    isCachedCondaInfoCoherent(
      {
        executable,
        path: root,
        updatedAt: 1,
        coherenceFingerprint: changedEnvironment,
        info: configuredInfo,
      },
      changedEnvironment,
    ),
    true,
  );
  assert.equal(
    isCachedCondaInfoCoherent(
      { executable, path: root, updatedAt: 1, info: configuredInfo },
      changedEnvironment,
    ),
    false,
  );
});

test('fingerprints lexical and resolved executable identity', async (t) => {
  if (process.platform === 'win32') {
    t.skip('file symlinks require additional privileges on Windows');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-info-executable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const first = path.join(root, 'first', 'conda');
  const second = path.join(root, 'second', 'conda');
  const executable = path.join(bin, 'conda');
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(path.dirname(first), { recursive: true }),
    mkdir(path.dirname(second), { recursive: true }),
  ]);
  await Promise.all([writeFile(first, ''), writeFile(second, '')]);
  await symlink(first, executable);

  const initial = await condaInfoCoherenceFingerprint('conda', info, { PATH: bin });
  await rm(executable);
  await symlink(second, executable);
  const repointed = await condaInfoCoherenceFingerprint('conda', info, { PATH: bin });

  assert.notEqual(repointed, initial);
});
