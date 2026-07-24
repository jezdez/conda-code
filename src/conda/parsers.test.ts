import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CondaJsonParseError,
  parseCondaInfo,
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
  parseWorkspaceTaskList,
} from './parsers';

test('parseCondaInfo normalizes the conda JSON fields', () => {
  const info = parseCondaInfo(
    JSON.stringify({
      platform: 'osx-arm64',
      conda_version: '26.5.3',
      root_prefix: '/opt/conda',
      conda_prefix: '/opt/conda',
      envs_dirs: ['/opt/conda/envs'],
      default_prefix: '/opt/conda',
      active_prefix: null,
      active_prefix_name: null,
      envs: ['/opt/conda', '/work/.conda/envs/default'],
      ignored_forward_compatible_field: true,
    }),
  );

  assert.deepEqual(info, {
    platform: 'osx-arm64',
    condaVersion: '26.5.3',
    rootPrefix: '/opt/conda',
    condaPrefix: '/opt/conda',
    envsDirs: ['/opt/conda/envs'],
    defaultPrefix: '/opt/conda',
    activePrefix: null,
    activePrefixName: null,
    envs: ['/opt/conda', '/work/.conda/envs/default'],
  });
});

test('parseWorkspaceInfo preserves lockfile status details', () => {
  const info = parseWorkspaceInfo(
    JSON.stringify({
      manifest: '/work/conda.toml',
      name: 'demo',
      version: '1.0',
      description: 'Demo workspace',
      channels: ['conda-forge'],
      platforms: ['osx-arm64'],
      known_platforms: ['osx-arm64', 'linux-64'],
      environments: ['default', 'test'],
      features: ['test'],
      lockfile_status: 'out-of-date',
      lockfile_reason: 'dependency changed',
    }),
  );

  assert.equal(info.lockfileStatus, 'out-of-date');
  assert.equal(info.lockfileReason, 'dependency changed');
  assert.deepEqual(info.environments, ['default', 'test']);
  assert.deepEqual(info.knownPlatforms, ['osx-arm64', 'linux-64']);
});

test('parseWorkspaceEnvironments parses installed state and features', () => {
  assert.deepEqual(
    parseWorkspaceEnvironments(
      JSON.stringify([
        { name: 'default', features: [], installed: true },
        { name: 'test', features: ['test'], installed: false },
      ]),
    ),
    [
      { name: 'default', features: [], installed: true },
      { name: 'test', features: ['test'], installed: false },
    ],
  );
});

test('parseWorkspaceEnvironmentInfo handles installed package counts', () => {
  const info = parseWorkspaceEnvironmentInfo(
    JSON.stringify({
      name: 'default',
      prefix: '/work/.conda/envs/default',
      installed: true,
      channels: ['conda-forge'],
      platforms: ['osx-arm64'],
      channel_priority: 'strict',
      conda_dependencies: { python: 'python >=3.12', numpy: 'numpy' },
      pypi_dependencies: { click: 'click>=8' },
      packages_installed: 42,
    }),
  );

  assert.equal(info.prefix, '/work/.conda/envs/default');
  assert.equal(info.channelPriority, 'strict');
  assert.equal(info.packageCount, 42);
  assert.deepEqual(info.condaDependencies, {
    python: 'python >=3.12',
    numpy: 'numpy',
  });
});

test('parseWorkspacePackages parses package records', () => {
  assert.deepEqual(
    parseWorkspacePackages(
      JSON.stringify([
        { name: 'numpy', version: '2.4.1', build: 'py312_0' },
        { name: 'python', version: '3.12.12', build: 'h123_0' },
      ]),
    ),
    [
      { name: 'numpy', version: '2.4.1', build: 'py312_0' },
      { name: 'python', version: '3.12.12', build: 'h123_0' },
    ],
  );
});

test('parseWorkspaceTaskList normalizes commands, aliases, and sources', () => {
  const result = parseWorkspaceTaskList(
    JSON.stringify({
      file: '/work/conda.toml',
      tasks: {
        lint: {
          name: 'lint',
          cmd: ['ruff', 'check', '.'],
          description: 'Lint',
          source: 'user',
        },
        check: {
          name: 'check',
          depends_on: ['lint', 'test'],
          alias: true,
        },
      },
    }),
  );

  assert.deepEqual(result.tasks.lint, {
    name: 'lint',
    command: ['ruff', 'check', '.'],
    description: 'Lint',
    dependsOn: [],
    alias: false,
    source: 'user',
  });
  assert.deepEqual(result.tasks.check, {
    name: 'check',
    dependsOn: ['lint', 'test'],
    alias: true,
  });
});

test('parseWorkspaceQuickstartResult normalizes its payload', () => {
  assert.deepEqual(
    parseWorkspaceQuickstartResult(
      JSON.stringify({
        workspace: '/work/demo',
        environment: 'default',
        manifest: 'conda.toml',
        specs_added: ['python=3.12'],
        shell_spawned: false,
      }),
    ),
    {
      workspace: '/work/demo',
      environment: 'default',
      manifest: 'conda.toml',
      specsAdded: ['python=3.12'],
      shellSpawned: false,
    },
  );
});

test('parsers reject malformed fields with a useful path', () => {
  assert.throws(
    () =>
      parseWorkspaceEnvironments(
        JSON.stringify([{ name: 'default', features: [], installed: 'yes' }]),
      ),
    (error: unknown) =>
      error instanceof CondaJsonParseError &&
      error.message.includes('conda workspace envs[0].installed'),
  );
});
