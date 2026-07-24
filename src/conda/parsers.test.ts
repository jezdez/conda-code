import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CondaJsonParseError,
  parseCondaInfo,
  parseCondaMutationPrefix,
  parseCondaPackages,
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
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
      envs_details: {
        '/opt/conda': { name: 'base', ignored: true },
        '/work/.conda/envs/default': { name: '' },
      },
      ignored_forward_compatible_field: true,
    }),
  );

  assert.deepEqual(info, {
    platform: 'osx-arm64',
    rootPrefix: '/opt/conda',
    envsDirs: ['/opt/conda/envs'],
    defaultPrefix: '/opt/conda',
    activePrefix: null,
    envs: ['/opt/conda', '/work/.conda/envs/default'],
    envsDetails: {
      '/opt/conda': { name: 'base' },
      '/work/.conda/envs/default': { name: '' },
    },
  });
});

test('parseCondaPackages keeps package build and channel details', () => {
  assert.deepEqual(
    parseCondaPackages(
      JSON.stringify([
        {
          name: 'python',
          version: '3.13.5',
          build_string: 'h123_0',
          channel: 'conda-forge',
          platform: 'noarch',
          ignored: true,
        },
        { name: 'local-package', version: '1.0' },
      ]),
    ),
    [
      {
        name: 'python',
        version: '3.13.5',
        build: 'h123_0',
        channel: 'conda-forge',
        platform: 'noarch',
      },
      { name: 'local-package', version: '1.0', build: '' },
    ],
  );
});

test('parseCondaMutationPrefix accepts current and legacy conda result shapes', () => {
  assert.equal(parseCondaMutationPrefix(JSON.stringify({ prefix: '/envs/demo' })), '/envs/demo');
  assert.equal(
    parseCondaMutationPrefix(JSON.stringify({ actions: { PREFIX: '/envs/legacy' } })),
    '/envs/legacy',
  );
});

test('parseWorkspaceInfo reads only fields used by discovery', () => {
  const info = parseWorkspaceInfo(
    JSON.stringify({
      manifest: '/work/conda.toml',
      name: 'demo',
      version: 1,
      channels: 'ignored',
      lockfile_status: null,
    }),
  );

  assert.deepEqual(info, {
    manifest: '/work/conda.toml',
    name: 'demo',
  });
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

test('parseWorkspaceEnvironmentInfo reads route and dependency fields', () => {
  const info = parseWorkspaceEnvironmentInfo(
    JSON.stringify({
      name: 'default',
      prefix: '/work/.conda/envs/default',
      conda_dependencies: { python: 'python >=3.12', numpy: 'numpy' },
      installed: 'ignored',
      channels: null,
      pypi_dependencies: false,
    }),
  );

  assert.deepEqual(info, {
    name: 'default',
    prefix: '/work/.conda/envs/default',
    condaDependencies: {
      python: 'python >=3.12',
      numpy: 'numpy',
    },
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

test('parseWorkspaceQuickstartResult reads only the created environment identity', () => {
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
      environment: 'default',
      manifest: 'conda.toml',
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
