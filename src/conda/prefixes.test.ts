import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CondaInfo } from './parsers';
import {
  condaGlobalEnvironmentRoots,
  condaPrefixCandidates,
  inspectCondaPrefix,
  isCondaGlobalPrefix,
  isManagedProjectPrefix,
  isPathWithin,
  isPixiEnvironmentPrefix,
  isRemovableCondaPrefix,
  isRemovableManagedProjectPrefix,
  pythonExecutablePath,
} from './prefixes';

function info(rootPrefix: string, envsDir: string): CondaInfo {
  return {
    platform: 'linux-64',
    rootPrefix,
    envsDirs: [envsDir],
    defaultPrefix: rootPrefix,
    activePrefix: null,
    envs: [rootPrefix],
    envsDetails: {},
  };
}

test('inspectCondaPrefix reads Python metadata without running the environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envsDir = path.join(root, 'envs');
  const prefix = path.join(envsDir, 'demo');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h123_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
  );
  await writeFile(path.join(prefix, 'bin', 'python'), '');

  assert.deepEqual(await inspectCondaPrefix(prefix, info(root, envsDir)), {
    prefix,
    name: 'demo',
    kind: 'named',
    pythonPath: path.join(prefix, 'bin', 'python'),
    pythonVersion: '3.13.5',
    pythonExists: true,
    condaInstallation: false,
  });
});

test('inspectCondaPrefix honors the Python record platform', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-win-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'win-env');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h123_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'win-64' }),
  );
  await writeFile(path.join(prefix, 'python.exe'), '');

  const metadata = await inspectCondaPrefix(prefix, info(root, path.join(root, 'envs')));
  assert.equal(metadata?.pythonPath, path.join(prefix, 'python.exe'));
  assert.equal(metadata?.pythonExists, true);
});

test('inspectCondaPrefix retains environments without Python', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-no-python-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envsDir = path.join(root, 'named');
  const prefix = path.join(root, 'project', '.conda');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });

  assert.deepEqual(await inspectCondaPrefix(prefix, info(root, envsDir)), {
    prefix,
    name: '.conda',
    kind: 'prefix',
    pythonPath: path.join(prefix, 'bin', 'python'),
    pythonVersion: null,
    pythonExists: false,
    condaInstallation: false,
  });
});

test('inspectCondaPrefix marks another conda installation root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-installation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'conda-meta'), { recursive: true });
  await mkdir(path.join(root, 'condabin'));

  const metadata = await inspectCondaPrefix(root, info('/configured/conda', '/configured/envs'));
  assert.equal(metadata?.kind, 'prefix');
  assert.equal(metadata?.condaInstallation, true);
});

test('prefix path helpers handle Windows and containment boundaries', () => {
  assert.equal(
    pythonExecutablePath(String.raw`C:\envs\demo`, 'win-64'),
    String.raw`C:\envs\demo\python.exe`,
  );
  assert.equal(isPathWithin('/home/user/.cg/envs', '/home/user/.cg/envs/ruff'), true);
  assert.equal(isPathWithin('/home/user/.cg/envs', '/home/user/.cg/envs-other/ruff'), false);
  assert.equal(isManagedProjectPrefix('/work/demo/.conda', '/work/demo'), true);
  assert.equal(isManagedProjectPrefix('/work/demo', '/work/demo'), false);
  assert.equal(isManagedProjectPrefix('/work/demo/.conda/envs/default', '/work/demo'), false);
});

test('condaPrefixCandidates accepts prefixes and standard Python executables', () => {
  const prefix = path.resolve('/work/demo/.conda');
  const python = path.join(prefix, 'bin', 'python');
  const versionedPython = path.join(prefix, 'bin', 'python3.13');

  assert.deepEqual(condaPrefixCandidates(prefix), [prefix]);
  assert.deepEqual(condaPrefixCandidates(python), [python, prefix]);
  assert.deepEqual(condaPrefixCandidates(versionedPython), [versionedPython, prefix]);
});

test('isRemovableManagedProjectPrefix rejects a symlinked .conda prefix', async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), 'conda-code-project-prefix-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const target = path.join(project, 'target');
  const prefix = path.join(project, '.conda');
  await mkdir(target);
  await symlink(target, prefix, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(await isRemovableCondaPrefix(prefix), false);
  assert.equal(await isRemovableManagedProjectPrefix(prefix, project), false);
  await rm(prefix);
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  assert.equal(await isRemovableCondaPrefix(prefix), true);
  assert.equal(await isRemovableManagedProjectPrefix(prefix, project), true);
});

test('conda-global uses its configured root', () => {
  const home = path.resolve('/home/person');
  const roots = condaGlobalEnvironmentRoots({ CONDA_GLOBAL_HOME: '~/tools' }, home);
  assert.deepEqual(roots, [path.join(home, 'tools', 'envs')]);
  assert.equal(isCondaGlobalPrefix(path.join(home, 'tools', 'envs', 'ruff'), roots), true);
  assert.equal(isCondaGlobalPrefix(path.join(home, '.cg', 'envs', 'gh'), roots), false);
  assert.equal(isCondaGlobalPrefix(path.join(home, '.conda', 'envs', 'project'), roots), false);
});

test('conda-global keeps legacy installs on the legacy root', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'conda-code-global-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.cg'));

  assert.deepEqual(condaGlobalEnvironmentRoots({}, home), [path.join(home, '.cg', 'envs')]);
});

test('conda-global resolves a configured symlink', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-global-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const linked = path.join(root, 'linked');
  await mkdir(path.join(actual, 'envs', 'ruff'), { recursive: true });
  await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');

  const roots = condaGlobalEnvironmentRoots({ CONDA_GLOBAL_HOME: linked }, root);
  assert.equal(isCondaGlobalPrefix(path.join(actual, 'envs', 'ruff'), roots), true);
});

test('Pixi environment prefixes are recognized across path separators', () => {
  assert.equal(isPixiEnvironmentPrefix('/work/project/.pixi/envs/default'), true);
  assert.equal(isPixiEnvironmentPrefix(String.raw`C:\work\project\.pixi\envs\test`), true);
  assert.equal(isPixiEnvironmentPrefix('/work/project/.pixi/cache'), false);
});
