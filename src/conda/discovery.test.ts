import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverCondaPrefixes } from './discovery';
import type { CondaInfo } from './parsers';
import { canonicalCondaPath, type CondaPrefixMetadata } from './prefixes';
import { normalizeEnvironmentPath } from './workspaceRouting';

function info(rootPrefix: string, envsDirs: readonly string[]): CondaInfo {
  return {
    platform: process.platform === 'win32' ? 'win-64' : 'linux-64',
    rootPrefix,
    envsDirs,
    defaultPrefix: rootPrefix,
    activePrefix: null,
    envs: [],
    envsDetails: {},
  };
}

async function createInstallation(
  root: string,
  executableName = process.platform === 'win32' ? 'conda.exe' : 'conda',
): Promise<string> {
  const executableDirectory =
    process.platform === 'win32' ? path.join(root, 'Scripts') : path.join(root, 'bin');
  const executable = path.join(executableDirectory, executableName);
  await Promise.all([
    mkdir(path.join(root, 'conda-meta'), { recursive: true }),
    mkdir(path.join(root, 'pkgs'), { recursive: true }),
    mkdir(path.join(root, 'envs'), { recursive: true }),
    mkdir(executableDirectory, { recursive: true }),
  ]);
  await writeFile(executable, '');
  return executable;
}

async function createEnvironment(prefix: string, history?: string): Promise<void> {
  await mkdir(path.join(prefix, 'conda-meta'), { recursive: true });
  if (history !== undefined) {
    await writeFile(path.join(prefix, 'conda-meta', 'history'), `${history}\n`);
  }
}

function byPrefix(metadata: readonly CondaPrefixMetadata[], prefix: string): CondaPrefixMetadata {
  const expected = normalizeEnvironmentPath(prefix);
  const found = metadata.find((item) => normalizeEnvironmentPath(item.prefix) === expected);
  assert.ok(found, `Expected to discover ${prefix}`);
  return found;
}

test('discovers and owns multiple installations without running conda or Python', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const primaryExecutable = await createInstallation(primary);
  const secondaryExecutable = await createInstallation(secondary);
  const primaryNamed = path.join(primary, 'envs', 'duplicate');
  const secondaryNamed = path.join(secondary, 'envs', 'duplicate');
  const externalNamed = path.join(root, 'external', 'named');
  const externalPrefix = path.join(root, 'external', 'prefix');
  const unknown = path.join(root, 'external', 'unknown');
  const nestedExecutable = await createInstallation(primaryNamed);
  await Promise.all([
    createEnvironment(secondaryNamed),
    createEnvironment(externalNamed, `# cmd: ${primaryExecutable} create --name named python`),
    createEnvironment(
      externalPrefix,
      `# cmd: ${primaryExecutable} create --prefix ${externalPrefix} python`,
    ),
    createEnvironment(unknown),
    mkdir(path.join(home, '.conda'), { recursive: true }),
  ]);
  await writeFile(
    path.join(home, '.conda', 'environments.txt'),
    [externalNamed, externalPrefix, unknown, externalNamed].join('\n'),
  );

  const { metadata: discovered } = await discoverCondaPrefixes(
    info(primary, [path.join(primary, 'envs')]),
    {
      condaExecutable: primaryExecutable,
      environment: {
        PATH: [path.dirname(secondaryExecutable), path.dirname(nestedExecutable)].join(
          path.delimiter,
        ),
      },
      userHome: home,
      standardRoots: [],
    },
  );

  assert.equal(byPrefix(discovered, primary).kind, 'base');
  assert.equal(byPrefix(discovered, secondary).kind, 'base');
  assert.deepEqual(
    [byPrefix(discovered, primaryNamed), byPrefix(discovered, secondaryNamed)].map(
      (item) => item.name,
    ),
    ['duplicate', 'duplicate'],
  );
  assert.equal(byPrefix(discovered, primaryNamed).kind, 'named');
  assert.equal(byPrefix(discovered, secondaryNamed).kind, 'named');
  assert.equal(byPrefix(discovered, primaryNamed).ownerRoot, primary);
  assert.equal(byPrefix(discovered, primaryNamed).ownerExecutable, primaryExecutable);
  assert.equal(byPrefix(discovered, secondaryNamed).ownerRoot, secondary);
  assert.equal(byPrefix(discovered, secondaryNamed).ownerExecutable, secondaryExecutable);
  assert.equal(byPrefix(discovered, externalNamed).kind, 'named');
  assert.equal(byPrefix(discovered, externalNamed).ownerRoot, primary);
  assert.equal(byPrefix(discovered, externalPrefix).kind, 'prefix');
  assert.equal(byPrefix(discovered, externalPrefix).ownerRoot, primary);
  assert.equal(byPrefix(discovered, unknown).kind, 'prefix');
  assert.equal(byPrefix(discovered, unknown).ownerRoot, undefined);
  assert.equal(
    discovered.filter(
      (item) => normalizeEnvironmentPath(item.prefix) === normalizeEnvironmentPath(externalNamed),
    ).length,
    1,
  );
});

test('additional installations expand one level when global sources are disabled', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-local-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const hiddenRegistryPrefix = path.join(root, 'registry-only');
  const primaryExecutable = await createInstallation(primary);
  await createInstallation(secondary);
  const secondaryNamed = path.join(secondary, 'envs', 'secondary-name');
  await Promise.all([
    createEnvironment(secondaryNamed),
    createEnvironment(hiddenRegistryPrefix),
    mkdir(path.join(home, '.conda'), { recursive: true }),
  ]);
  await writeFile(path.join(home, '.conda', 'environments.txt'), hiddenRegistryPrefix);

  const { metadata: discovered } = await discoverCondaPrefixes(
    info(primary, [path.join(primary, 'envs')]),
    {
      condaExecutable: primaryExecutable,
      additionalPrefixes: [secondary],
      environment: {},
      userHome: home,
      standardRoots: [],
      includeGlobalSources: false,
    },
  );

  assert.equal(byPrefix(discovered, secondary).kind, 'base');
  assert.equal(byPrefix(discovered, secondaryNamed).kind, 'named');
  assert.equal(
    discovered.some(
      (item) =>
        normalizeEnvironmentPath(item.prefix) === normalizeEnvironmentPath(hiddenRegistryPrefix),
    ),
    false,
  );
});

test('global roots and custom environment directories are expanded one level', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-source-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const configuredRoot = path.join(root, 'configured-root');
  const standardRoot = path.join(root, 'standard-root');
  const customEnvs = path.join(root, 'custom-envs');
  const primaryExecutable = await createInstallation(primary);
  await Promise.all([
    createInstallation(configuredRoot),
    createInstallation(standardRoot),
    createEnvironment(path.join(customEnvs, 'custom')),
  ]);

  const { metadata: discovered } = await discoverCondaPrefixes(
    info(primary, [path.join(primary, 'envs')]),
    {
      condaExecutable: primaryExecutable,
      environment: {
        CONDA_ROOT_PREFIX: configuredRoot,
        CONDA_ENVS_PATH: customEnvs,
        PATH: '',
      },
      userHome: home,
      standardRoots: [standardRoot],
    },
  );

  assert.equal(byPrefix(discovered, configuredRoot).kind, 'base');
  assert.equal(byPrefix(discovered, standardRoot).kind, 'base');
  assert.equal(byPrefix(discovered, path.join(customEnvs, 'custom')).kind, 'named');
});

test('primary external environment directories retain their removal boundary', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-external-owner-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const externalEnvsDir = path.join(root, 'external-envs');
  const prefix = path.join(externalEnvsDir, 'demo');
  const primaryExecutable = await createInstallation(primary);
  await createEnvironment(prefix);

  const { metadata: discovered } = await discoverCondaPrefixes(info(primary, [externalEnvsDir]), {
    condaExecutable: primaryExecutable,
    environment: { PATH: '' },
    userHome: home,
    standardRoots: [],
  });

  const metadata = byPrefix(discovered, prefix);
  assert.equal(metadata.kind, 'named');
  assert.equal(metadata.ownerRoot, primary);
  assert.equal(metadata.ownerEnvsDir, externalEnvsDir);
});

test('canonical identities deduplicate installation and prefix aliases', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-alias-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const primaryAlias = path.join(root, 'primary-alias');
  const named = path.join(primary, 'envs', 'demo');
  const namedAlias = path.join(root, 'named-alias');
  const primaryExecutable = await createInstallation(primary);
  await createEnvironment(named);
  await Promise.all([
    symlink(primary, primaryAlias, process.platform === 'win32' ? 'junction' : 'dir'),
    symlink(named, namedAlias, process.platform === 'win32' ? 'junction' : 'dir'),
    mkdir(path.join(home, '.conda'), { recursive: true }),
  ]);
  await writeFile(path.join(home, '.conda', 'environments.txt'), [namedAlias, named].join('\n'));

  const { metadata: discovered } = await discoverCondaPrefixes(
    info(primaryAlias, [path.join(primaryAlias, 'envs')]),
    {
      condaExecutable: path.join(primaryAlias, 'bin', path.basename(primaryExecutable)),
      environment: { PATH: '' },
      userHome: home,
      standardRoots: [primary],
    },
  );

  const namedIdentity = normalizeEnvironmentPath(await canonicalCondaPath(named));
  const discoveredIdentities = await Promise.all(
    discovered.map(async (item) => normalizeEnvironmentPath(await canonicalCondaPath(item.prefix))),
  );
  assert.equal(discoveredIdentities.filter((identity) => identity === namedIdentity).length, 1);
  assert.equal(byPrefix(discovered, namedAlias).ownerRoot, primary);
});

test('standard installation locations are discovered', async (t) => {
  const root = await canonicalCondaPath(
    await mkdtemp(path.join(tmpdir(), 'conda-code-standard-discovery-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const primary = path.join(root, 'primary');
  const standardRoot = path.join(home, 'opt', 'miniforge3');
  const primaryExecutable = await createInstallation(primary);
  await createInstallation(standardRoot);

  const { metadata: discovered } = await discoverCondaPrefixes(
    info(primary, [path.join(primary, 'envs')]),
    {
      condaExecutable: primaryExecutable,
      environment: { PATH: '' },
      userHome: home,
    },
  );

  assert.equal(byPrefix(discovered, standardRoot).kind, 'base');
});

test('creates process-free discovery information when no cached conda info exists', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-seed-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installation = path.join(root, 'installation');
  const external = path.join(root, 'external');
  const configuredEnvs = path.join(root, 'configured-envs');
  const executable = await createInstallation(installation);
  await Promise.all([
    createEnvironment(external),
    mkdir(path.join(home, '.conda'), { recursive: true }),
  ]);
  await writeFile(path.join(home, '.conda', 'environments.txt'), `${external}\n`);

  const result = await discoverCondaPrefixes(undefined, {
    condaExecutable: executable,
    environment: { CONDA_ENVS_DIRS: configuredEnvs, PATH: '' },
    userHome: home,
    standardRoots: [],
  });

  assert.equal(result.info.rootPrefix, await canonicalCondaPath(installation));
  assert.equal(result.primaryRootResolved, true);
  assert.ok(result.info.envs.includes(external));
  assert.ok(result.info.envsDirs.includes(configuredEnvs));
  assert.ok(result.watchPaths.includes(path.join(home, '.conda', 'environments.txt')));
});

test('the configured conda installation replaces stale cached discovery information', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-primary-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const configured = path.join(root, 'configured');
  const stale = path.join(root, 'stale');
  const executable = await createInstallation(configured);

  const result = await discoverCondaPrefixes(info(stale, [path.join(stale, 'envs')]), {
    condaExecutable: executable,
    environment: { PATH: '' },
    userHome: home,
    standardRoots: [],
  });

  assert.equal(result.info.rootPrefix, await canonicalCondaPath(configured));
  assert.equal(result.primaryRootResolved, true);
  assert.equal(
    result.info.envsDirs.some((directory) => normalizeEnvironmentPath(directory).includes('stale')),
    false,
  );
});
