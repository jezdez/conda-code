import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CondaInfo } from './parsers';
import { isRunnableCondaExecutable } from './executable';
import {
  canonicalCondaPath,
  condaExecEnvironmentRoots,
  condaGlobalEnvironmentRoots,
  condaPrefixCandidates,
  findCondaExecutable,
  inspectCondaPrefix,
  isCondaExecPrefix,
  isCondaGlobalPrefix,
  isManagedProjectPrefix,
  isPathWithin,
  isPixiEnvironmentPrefix,
  isRemovableCondaPrefix,
  isRemovableManagedProjectPrefix,
  pythonExecutablePath,
} from './prefixes';
import { normalizeEnvironmentPath } from './workspaceRouting';

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
    ownerRoot: root,
    ownerEnvsDir: envsDir,
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

test('inspectCondaPrefix groups an ownerless Python environment as Named', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-ownerless-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'registered');
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  await mkdir(path.join(prefix, 'bin'));
  await writeFile(
    path.join(prefix, 'conda-meta', 'python-3.13.5-h123_0.json'),
    JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
  );
  await writeFile(path.join(prefix, 'bin', 'python'), '');

  const metadata = await inspectCondaPrefix(
    prefix,
    info(path.join(root, 'base'), path.join(root, 'base', 'envs')),
  );
  assert.equal(metadata?.kind, 'named');
  assert.equal(metadata?.ownerRoot, undefined);
  assert.equal(metadata?.ownerExecutable, undefined);
});

test('inspectCondaPrefix does not treat conda inside a named environment as an owner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-nested-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const runner = path.join(base, 'envs', 'runner');
  const prefix = path.join(root, 'external');
  await Promise.all([
    mkdir(path.join(base, 'conda-meta'), { recursive: true }),
    mkdir(path.join(base, 'envs'), { recursive: true }),
    mkdir(path.join(base, 'bin'), { recursive: true }),
    mkdir(path.join(runner, 'conda-meta'), { recursive: true }),
    mkdir(path.join(runner, 'bin'), { recursive: true }),
    mkdir(path.join(prefix, 'conda-meta'), { recursive: true }),
    mkdir(path.join(prefix, 'bin'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(base, 'bin', 'conda'), ''),
    writeFile(path.join(runner, 'bin', 'conda'), ''),
    writeFile(
      path.join(prefix, 'conda-meta', 'python-3.13.5-h123_0.json'),
      JSON.stringify({ name: 'python', version: '3.13.5', subdir: 'linux-64' }),
    ),
    writeFile(path.join(prefix, 'bin', 'python'), ''),
    writeFile(
      path.join(prefix, 'conda-meta', 'history'),
      `# cmd: ${path.join(
        runner,
        'lib',
        'python3.13',
        'site-packages',
        'conda',
        '__main__.py',
      )} create --prefix ${prefix} python\n`,
    ),
  ]);

  const metadata = await inspectCondaPrefix(prefix, info(base, path.join(base, 'envs')));
  assert.equal(metadata?.kind, 'named');
  assert.equal(metadata?.ownerRoot, undefined);
  assert.equal(metadata?.ownerExecutable, undefined);
});

test('inspectCondaPrefix resolves a conda shim recorded in history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-history-shim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const executable = path.join(
    base,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'conda.exe' : 'conda',
  );
  const shimDirectory = path.join(root, 'shims');
  const shim = path.join(shimDirectory, path.basename(executable));
  const prefix = path.join(root, 'external');
  await Promise.all([
    mkdir(path.join(base, 'conda-meta'), { recursive: true }),
    mkdir(path.join(base, 'envs'), { recursive: true }),
    mkdir(path.dirname(executable), { recursive: true }),
    mkdir(shimDirectory),
    mkdir(path.join(prefix, 'conda-meta'), { recursive: true }),
  ]);
  await writeFile(executable, '');
  await symlink(executable, shim);
  await writeFile(
    path.join(prefix, 'conda-meta', 'history'),
    `# cmd: ${shim} create --prefix ${prefix} python\n`,
  );

  const metadata = await inspectCondaPrefix(prefix, info(base, path.join(base, 'envs')));
  assert.equal(metadata?.kind, 'prefix');
  assert.equal(metadata?.ownerRoot, await canonicalCondaPath(base));
  assert.equal(metadata?.ownerExecutable, await canonicalCondaPath(executable));
});

test('inspectCondaPrefix never uses a non-conda command recorded in history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-history-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const bin = path.join(base, 'bin');
  const commands = ['solver', 'custom-tool'];
  await Promise.all([
    mkdir(path.join(base, 'conda-meta'), { recursive: true }),
    mkdir(path.join(base, 'pkgs'), { recursive: true }),
    mkdir(path.join(base, 'envs'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);

  for (const command of commands) {
    const executable = path.join(bin, command);
    const prefix = path.join(root, command);
    await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
    await writeFile(executable, '');
    await writeFile(
      path.join(prefix, 'conda-meta', 'history'),
      `# cmd: ${executable} create --prefix ${prefix} python\n`,
    );

    const metadata = await inspectCondaPrefix(
      prefix,
      info(path.join(root, 'primary'), path.join(root, 'primary', 'envs')),
    );
    assert.equal(metadata?.ownerRoot, await canonicalCondaPath(base));
    assert.equal(metadata?.ownerExecutable, undefined);
  }
});

test('inspectCondaPrefix marks another conda installation root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-installation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'conda-meta'), { recursive: true });
  await mkdir(path.join(root, 'condabin'));
  const metadata = await inspectCondaPrefix(root, info('/configured/conda', '/configured/envs'));
  assert.equal(metadata?.kind, 'base');
  assert.equal(metadata?.condaInstallation, true);
  assert.equal(metadata?.ownerRoot, root);
});

test('Windows owner discovery prefers native executables and rejects batch shims', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-windows-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeExecutable = path.join(root, 'Scripts', 'conda.exe');
  const batchShim = path.join(root, 'condabin', 'conda.bat');
  await Promise.all([
    mkdir(path.dirname(nativeExecutable), { recursive: true }),
    mkdir(path.dirname(batchShim), { recursive: true }),
  ]);
  await Promise.all([writeFile(nativeExecutable, ''), writeFile(batchShim, '')]);

  assert.equal(
    await findCondaExecutable(root, 'win32'),
    await canonicalCondaPath(nativeExecutable),
  );
  assert.equal(isRunnableCondaExecutable(batchShim, 'win32'), false);

  await rm(nativeExecutable);
  assert.equal(await findCondaExecutable(root, 'win32'), undefined);
});

test('inspectCondaPrefix keeps batch-only Windows owners read-only', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-windows-batch-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envsDir = path.join(root, 'envs');
  const prefix = path.join(envsDir, 'demo');
  const batchShim = path.join(root, 'condabin', 'conda.bat');
  await Promise.all([
    mkdir(path.join(root, 'conda-meta'), { recursive: true }),
    mkdir(path.join(prefix, 'conda-meta'), { recursive: true }),
    mkdir(path.dirname(batchShim), { recursive: true }),
  ]);
  await writeFile(batchShim, '');

  const metadata = await inspectCondaPrefix(prefix, info(root, envsDir), {
    ownerRoot: root,
    ownerExecutable: batchShim,
    ownerEnvsDirs: [envsDir],
  });

  assert.equal(metadata?.kind, 'named');
  assert.equal(metadata?.ownerRoot, await canonicalCondaPath(root));
  assert.equal(metadata?.ownerExecutable, undefined);
});

test('inspectCondaPrefix does not trust an unresolved primary root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-unresolved-primary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'conda-meta'));

  const metadata = await inspectCondaPrefix(root, info(root, path.join(root, 'envs')), {
    primaryRootTrusted: false,
  });

  assert.equal(metadata?.kind, 'prefix');
  assert.equal(metadata?.condaInstallation, false);
  assert.equal(metadata?.ownerRoot, undefined);
});

test('prefix path helpers handle Windows and containment boundaries', () => {
  assert.equal(
    pythonExecutablePath(String.raw`C:\envs\demo`, 'win-64'),
    String.raw`C:\envs\demo\python.exe`,
  );
  assert.equal(isPathWithin('/home/user/.cg/envs', '/home/user/.cg/envs/ruff'), true);
  assert.equal(isPathWithin('/home/user/.cg/envs', '/home/user/.cg/envs-other/ruff'), false);
  assert.equal(isPathWithin(String.raw`C:\envs`, String.raw`C:\envs\demo`), true);
  assert.equal(isPathWithin(String.raw`C:\envs`, String.raw`C:\envs-other\demo`), false);
  assert.equal(isPathWithin(String.raw`C:\envs`, String.raw`D:\envs\demo`), false);
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

test('isRemovableCondaPrefix rejects a symlink below its trusted owner root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-owner-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = path.join(root, 'owner');
  const target = path.join(root, 'target');
  const linkedDirectory = path.join(owner, 'envs');
  const prefix = path.join(linkedDirectory, 'demo');
  await mkdir(path.join(target, 'demo', 'conda-meta'), { recursive: true });
  await mkdir(owner);
  await symlink(target, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(await isRemovableCondaPrefix(prefix), true);
  assert.equal(await isRemovableCondaPrefix(prefix, owner), false);
  assert.equal(
    await canonicalCondaPath(prefix),
    await canonicalCondaPath(path.join(target, 'demo')),
  );
});

test('inspectCondaPrefix preserves the owning environment directory for safe removal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-external-envs-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const externalEnvsDir = path.join(root, 'external-envs');
  const prefix = path.join(externalEnvsDir, 'demo');
  await Promise.all([
    mkdir(path.join(base, 'conda-meta'), { recursive: true }),
    mkdir(path.join(base, 'envs'), { recursive: true }),
    mkdir(path.join(base, 'bin'), { recursive: true }),
    mkdir(path.join(prefix, 'conda-meta'), { recursive: true }),
  ]);
  await writeFile(path.join(base, 'bin', 'conda'), '');

  const metadata = await inspectCondaPrefix(prefix, info(base, externalEnvsDir), {
    ownerRoot: base,
    ownerEnvsDirs: [externalEnvsDir],
  });

  assert.equal(metadata?.kind, 'named');
  assert.equal(metadata?.ownerEnvsDir, externalEnvsDir);
  assert.equal(await isRemovableCondaPrefix(prefix, base), false);
  assert.equal(await isRemovableCondaPrefix(prefix, metadata?.ownerEnvsDir), true);
});

test('inspectCondaPrefix assigns a symlink alias to its canonical layout owner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-canonical-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configured = path.join(root, 'configured');
  const actual = path.join(root, 'actual');
  const executableDirectory = process.platform === 'win32' ? 'Scripts' : 'bin';
  const executableName = process.platform === 'win32' ? 'conda.exe' : 'conda';
  const configuredExecutable = path.join(configured, executableDirectory, executableName);
  const actualExecutable = path.join(actual, executableDirectory, executableName);
  const actualPrefix = path.join(actual, 'envs', 'demo');
  const alias = path.join(configured, 'envs', 'demo');
  await Promise.all([
    mkdir(path.join(configured, 'conda-meta'), { recursive: true }),
    mkdir(path.join(configured, 'envs'), { recursive: true }),
    mkdir(path.dirname(configuredExecutable), { recursive: true }),
    mkdir(path.join(actual, 'conda-meta'), { recursive: true }),
    mkdir(path.join(actualPrefix, 'conda-meta'), { recursive: true }),
    mkdir(path.dirname(actualExecutable), { recursive: true }),
  ]);
  await Promise.all([writeFile(configuredExecutable, ''), writeFile(actualExecutable, '')]);
  await symlink(actualPrefix, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const metadata = await inspectCondaPrefix(
    alias,
    info(configured, path.join(configured, 'envs')),
    {
      ownerRoot: configured,
      ownerExecutable: configuredExecutable,
      ownerEnvsDirs: [path.join(configured, 'envs')],
    },
  );

  assert.equal(metadata?.ownerRoot, await canonicalCondaPath(actual));
  assert.equal(metadata?.ownerExecutable, await canonicalCondaPath(actualExecutable));
  assert.equal(metadata?.ownerEnvsDir, await canonicalCondaPath(path.join(actual, 'envs')));
});

test('conda-global uses its configured root', () => {
  const home = path.resolve('/home/person');
  const roots = condaGlobalEnvironmentRoots({ CONDA_GLOBAL_HOME: '~/tools' }, home);
  assert.deepEqual(roots, [normalizeEnvironmentPath(path.join(home, 'tools', 'envs'))]);
  assert.equal(isCondaGlobalPrefix(path.join(home, 'tools', 'envs', 'ruff'), roots), true);
  assert.equal(isCondaGlobalPrefix(path.join(home, '.cg', 'envs', 'gh'), roots), false);
  assert.equal(isCondaGlobalPrefix(path.join(home, '.conda', 'envs', 'project'), roots), false);
});

test('conda-global keeps legacy installs on the legacy root', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'conda-code-global-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.cg'));

  assert.deepEqual(condaGlobalEnvironmentRoots({}, home), [
    normalizeEnvironmentPath(path.join(home, '.cg', 'envs')),
  ]);
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

test('conda-exec recognizes only cache entries below its active root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-exec-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const configuredEnvs = path.join(home, 'exec-cache', 'envs');
  const toolPrefix = path.join(configuredEnvs, 'ruff--abcd1234');
  const scriptPrefix = path.join(configuredEnvs, 'script--fedcba9876543210');
  const temporaryPrefix = path.join(configuredEnvs, '.tmp-abcdef');
  const ordinaryPrefix = path.join(configuredEnvs, 'project');
  const nestedPrefix = path.join(toolPrefix, 'nested');
  const outsidePrefix = path.join(home, 'elsewhere', 'ruff--abcd1234');
  const defaultRoot = path.join(home, '.conda', 'exec', 'envs');
  await Promise.all(
    [scriptPrefix, temporaryPrefix, ordinaryPrefix, nestedPrefix, outsidePrefix, defaultRoot].map(
      (prefix) => mkdir(prefix, { recursive: true }),
    ),
  );

  const configuredRoots = condaExecEnvironmentRoots({ CONDA_EXEC_HOME: '~/exec-cache' }, home);
  assert.deepEqual(configuredRoots, [
    normalizeEnvironmentPath(await canonicalCondaPath(configuredEnvs)),
  ]);
  assert.equal(isCondaExecPrefix(toolPrefix, configuredRoots), true);
  assert.equal(isCondaExecPrefix(scriptPrefix, configuredRoots), true);
  assert.equal(isCondaExecPrefix(temporaryPrefix, configuredRoots), true);
  assert.equal(isCondaExecPrefix(ordinaryPrefix, configuredRoots), false);
  assert.equal(isCondaExecPrefix(nestedPrefix, configuredRoots), false);
  assert.equal(isCondaExecPrefix(outsidePrefix, configuredRoots), false);
  assert.deepEqual(condaExecEnvironmentRoots({ CONDA_EXEC_HOME: '' }, home), [
    normalizeEnvironmentPath(await canonicalCondaPath(defaultRoot)),
  ]);
});

test('conda-exec recognizes cache prefixes through filesystem aliases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-exec-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const linked = path.join(root, 'linked');
  const prefix = path.join(actual, 'envs', 'ruff--0123456789abcdef');
  const alias = path.join(root, 'outside');
  await mkdir(prefix, { recursive: true });
  await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(prefix, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const roots = condaExecEnvironmentRoots({ CONDA_EXEC_HOME: linked }, root);
  assert.equal(isCondaExecPrefix(prefix, roots), true);
  assert.equal(isCondaExecPrefix(alias, roots), true);
});

test(
  'conda-exec uses the Windows local data fallback when its primary root is absent',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'conda-code-exec-windows-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const localData = path.join(root, 'local-data');
    const fallback = path.join(localData, 'conda', 'conda', 'exec', 'envs');
    await mkdir(fallback, { recursive: true });

    assert.deepEqual(condaExecEnvironmentRoots({ LOCALAPPDATA: localData }, home), [
      normalizeEnvironmentPath(await canonicalCondaPath(fallback)),
    ]);
  },
);

test('Pixi environment prefixes are recognized across path separators', () => {
  assert.equal(isPixiEnvironmentPrefix('/work/project/.pixi/envs/default'), true);
  assert.equal(isPixiEnvironmentPrefix(String.raw`C:\work\project\.pixi\envs\test`), true);
  assert.equal(isPixiEnvironmentPrefix('/work/project/.pixi/cache'), false);
});

test('Pixi environment prefixes are recognized through symlink aliases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-pixi-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'project', '.pixi', 'envs', 'default');
  const alias = path.join(root, 'outside');
  await mkdir(prefix, { recursive: true });
  await symlink(prefix, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(isPixiEnvironmentPrefix(alias), true);
  assert.equal(isPathWithin(path.join(root, 'project'), alias), true);
  assert.equal(isPathWithin(path.join(root, 'project'), path.join(alias, 'missing')), true);
});
