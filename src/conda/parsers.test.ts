import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCondaInfo,
  parseCondaMutationPrefix,
  parseCondaPackages,
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
  parseWorkspaceSnapshot,
  parseWorkspaceTasks,
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
      config_files: ['/opt/conda/.condarc', '/home/me/.condarc'],
      rc_path: '/home/me/.condarc',
      user_rc_path: '/home/me/.condarc',
      sys_rc_path: '/opt/conda/.condarc',
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
    configFiles: ['/opt/conda/.condarc', '/home/me/.condarc'],
    rcPath: '/home/me/.condarc',
    userRcPath: '/home/me/.condarc',
    sysRcPath: '/opt/conda/.condarc',
    envsDetails: {
      '/opt/conda': { name: 'base' },
      '/work/.conda/envs/default': { name: '' },
    },
  });
});

test('parseCondaInfo accepts missing configuration paths', () => {
  const info = parseCondaInfo(
    JSON.stringify({
      platform: 'linux-64',
      root_prefix: '/opt/conda',
      envs_dirs: ['/opt/conda/envs'],
      default_prefix: '/opt/conda',
      active_prefix: null,
      envs: ['/opt/conda'],
    }),
  );

  assert.equal(info.configFiles, undefined);
  assert.equal(info.rcPath, undefined);
  assert.equal(info.userRcPath, undefined);
  assert.equal(info.sysRcPath, undefined);
});

test('parseCondaInfo rejects malformed configuration paths', () => {
  const requiredFields = {
    platform: 'linux-64',
    root_prefix: '/opt/conda',
    envs_dirs: ['/opt/conda/envs'],
    default_prefix: '/opt/conda',
    active_prefix: null,
    envs: ['/opt/conda'],
  };
  const malformed = [
    ['config_files', ['/opt/conda/.condarc', 42], 'conda info.config_files[1]'],
    ['rc_path', null, 'conda info.rc_path'],
    ['user_rc_path', false, 'conda info.user_rc_path'],
    ['sys_rc_path', [], 'conda info.sys_rc_path'],
  ] as const;

  for (const [field, value, expectedPath] of malformed) {
    assert.throws(
      () => parseCondaInfo(JSON.stringify({ ...requiredFields, [field]: value })),
      (error: unknown) => error instanceof Error && error.message.includes(expectedPath),
    );
  }
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
      pypi_dependencies: {
        black: '>=25',
        editable: { path: '.', editable: true },
      },
    }),
  );

  assert.deepEqual(info, {
    name: 'default',
    prefix: '/work/.conda/envs/default',
    condaDependencies: {
      python: 'python >=3.12',
      numpy: 'numpy',
    },
    pypiDependencies: ['black', 'editable'],
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

test('parseWorkspaceSnapshot keeps packages and structured dependency provenance', () => {
  assert.deepEqual(
    parseWorkspaceSnapshot(
      JSON.stringify({
        manifest: '/work/conda.toml',
        name: 'demo',
        environment_details: [
          {
            name: 'test',
            features: ['test'],
            prefix: '/work/.conda/envs/test',
            installed: true,
            resolutions: [
              {
                platform: 'linux-64',
                subdir: 'linux-64',
                conda_dependencies: {
                  ruff: {
                    spec: 'ruff',
                    provenance: {
                      table: '[workspace.dependencies]',
                      location: {
                        environment: null,
                        feature: null,
                        platform: null,
                      },
                    },
                  },
                  python: {
                    spec: 'python >=3.12',
                    provenance: {
                      table: '[feature.test.dependencies]',
                      location: {
                        environment: null,
                        feature: 'test',
                        platform: null,
                      },
                    },
                  },
                },
                pypi_dependencies: {
                  black: {
                    spec: 'black>=25',
                    provenance: {
                      table: '[environments.test.pypi-dependencies]',
                      location: {
                        environment: 'test',
                        feature: null,
                        platform: null,
                      },
                    },
                  },
                },
              },
            ],
            packages: [{ name: 'python', version: '3.13.5', build: 'h1_0' }],
          },
        ],
      }),
    ),
    {
      manifest: '/work/conda.toml',
      name: 'demo',
      environments: [
        {
          name: 'test',
          features: ['test'],
          prefix: '/work/.conda/envs/test',
          installed: true,
          resolutions: [
            {
              platform: 'linux-64',
              subdir: 'linux-64',
              dependencies: [
                {
                  name: 'ruff',
                  pypi: false,
                  table: '[workspace.dependencies]',
                  location: {},
                },
                {
                  name: 'python',
                  pypi: false,
                  table: '[feature.test.dependencies]',
                  location: { feature: 'test' },
                },
                {
                  name: 'black',
                  pypi: true,
                  table: '[environments.test.pypi-dependencies]',
                  location: { environment: 'test' },
                },
              ],
            },
          ],
          packages: [{ name: 'python', version: '3.13.5', build: 'h1_0' }],
        },
      ],
    },
  );
});

test('parseWorkspaceSnapshot accepts provenance without structured selectors', () => {
  const snapshot = parseWorkspaceSnapshot(
    JSON.stringify({
      manifest: '/work/conda.toml',
      name: 'demo',
      environment_details: [
        {
          name: 'default',
          features: [],
          prefix: '/work/.conda/envs/default',
          installed: true,
          resolutions: [
            {
              platform: 'linux-64',
              subdir: 'linux-64',
              conda_dependencies: {
                python: {
                  spec: 'python',
                  provenance: { table: '[workspace.dependencies]' },
                },
              },
              pypi_dependencies: {},
            },
          ],
          packages: [],
        },
      ],
    }),
  );

  assert.equal(snapshot.environments[0]?.resolutions[0]?.dependencies[0]?.location, undefined);
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

test('parseWorkspaceTasks reads task identities and descriptions', () => {
  assert.deepEqual(
    parseWorkspaceTasks(
      JSON.stringify({
        tasks: {
          docs: {
            name: 'docs',
            cmd: 'sphinx-build docs build',
            description: 'Build the documentation',
          },
          check: {
            name: 'check',
            depends_on: ['lint', 'test'],
            alias: true,
          },
          clean: {
            name: 'clean',
            cmd: 'git clean -fdx',
            source: 'user',
          },
        },
        file: '/work/conda.toml',
      }),
    ),
    {
      file: '/work/conda.toml',
      tasks: [
        { name: 'docs', description: 'Build the documentation' },
        { name: 'check' },
        { name: 'clean', source: 'user' },
      ],
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
      error instanceof Error && error.message.includes('conda workspace envs[0].installed'),
  );
  assert.throws(
    () =>
      parseWorkspaceTasks(
        JSON.stringify({
          tasks: { docs: { name: 'build' } },
          file: '/work/conda.toml',
        }),
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('conda task list.tasks.docs.name'),
  );
});
