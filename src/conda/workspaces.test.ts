import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { type CommandResult, type CommandRunner, type RunCommandOptions } from './runner';
import { CondaWorkspacesClient } from './workspaces';

interface RecordedCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: RunCommandOptions | undefined;
}

class RecordingRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];

  public constructor(
    private readonly handle: (
      executable: string,
      args: readonly string[],
      options: RunCommandOptions | undefined,
    ) => CommandResult | Promise<CommandResult>,
  ) {}

  public async run(
    executable: string,
    args: readonly string[],
    options?: RunCommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ executable, args: [...args], options });
    return this.handle(executable, args, options);
  }
}

function success(value: unknown = ''): CommandResult {
  return {
    exitCode: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function environmentInfo(name: string, prefix: string, packageCount: number): object {
  return {
    name,
    prefix,
    installed: true,
    channels: ['conda-forge'],
    platforms: ['linux-64'],
    channel_priority: 'strict',
    conda_dependencies: { python: 'python >=3.12' },
    pypi_dependencies: {},
    packages_installed: packageCount,
  };
}

test('read methods issue the documented JSON commands', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const prefix = path.resolve('/work/.conda/default');
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command.endsWith('info --json')) {
      return success({
        manifest,
        name: 'demo',
        version: '',
        description: '',
        channels: ['conda-forge'],
        platforms: ['linux-64'],
        known_platforms: ['linux-64'],
        environments: ['default'],
        features: [],
        lockfile_status: 'up-to-date',
      });
    }
    if (command.endsWith('envs --json')) {
      return success([{ name: 'default', features: [], installed: true }]);
    }
    if (command.endsWith('info -e default --json')) {
      return success(environmentInfo('default', prefix, 2));
    }
    if (command.endsWith('list -e default --json')) {
      return success([{ name: 'python', version: '3.12.12', build: 'h123_0' }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({
    runner,
    condaExecutable: '_conda',
    maxOutputBytes: 1024,
  });

  await client.getWorkspaceInfo(manifest);
  await client.listEnvironments(manifest);
  await client.getEnvironmentInfo(manifest, 'default');
  await client.listPackages(manifest, 'default');

  assert.deepEqual(
    runner.calls.map(({ executable, args, options }) => ({
      executable,
      args,
      cwd: options?.cwd,
      maxOutputBytes: options?.maxOutputBytes,
    })),
    [
      {
        executable: '_conda',
        args: ['workspace', '--file', manifest, 'info', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '_conda',
        args: ['workspace', '--file', manifest, 'envs', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '_conda',
        args: ['workspace', '--file', manifest, 'info', '-e', 'default', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '_conda',
        args: ['workspace', '--file', manifest, 'list', '-e', 'default', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
    ],
  );
});

test('listTasks delegates JSON discovery to conda task', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const runner = new RecordingRunner(() =>
    success({
      tasks: {
        docs: {
          name: 'docs',
          description: 'Build documentation',
          cmd: 'sphinx-build docs build',
        },
      },
      file: manifest,
    }),
  );
  const client = new CondaWorkspacesClient({
    runner,
    condaExecutable: '_conda',
  });

  assert.deepEqual(await client.listTasks(manifest), {
    file: manifest,
    tasks: [{ name: 'docs', description: 'Build documentation' }],
  });
  assert.deepEqual(runner.calls[0], {
    executable: '_conda',
    args: ['task', '--file', manifest, 'list', '--json'],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: path.dirname(manifest),
    },
  });
});

test('discoverWorkspace reads installed environments and packages in one snapshot', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const prefix = path.resolve('/work/project/.conda/envs/test');
  const condaPlatform = process.platform === 'win32' ? 'win-64' : 'linux-64';
  const runner = new RecordingRunner(() =>
    success({
      manifest,
      name: 'demo',
      lockfile_status: 'out-of-date',
      lockfile_reason: 'feature test changed',
      environment_details: [
        {
          name: 'test',
          features: ['test'],
          platforms: [condaPlatform],
          prefix,
          installed: true,
          resolutions: [
            {
              platform: condaPlatform,
              subdir: condaPlatform,
              conda_dependencies: {
                python: {
                  spec: 'python >=3.12',
                  provenance: {
                    table: '[feature.test.dependencies]',
                    location: { feature: 'test' },
                  },
                },
              },
              pypi_dependencies: {},
            },
          ],
          packages: [{ name: 'python', version: '3.13.5', build: 'h1_0' }],
        },
        {
          name: 'docs',
          features: ['docs'],
          platforms: [condaPlatform],
          prefix: path.resolve('/work/project/.conda/envs/docs'),
          installed: false,
          resolutions: [
            {
              platform: condaPlatform,
              subdir: condaPlatform,
              conda_dependencies: {
                sphinx: {
                  spec: 'sphinx',
                  provenance: {
                    table: '[feature.docs.dependencies]',
                    location: { feature: 'docs' },
                  },
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
  const client = new CondaWorkspacesClient({ runner });

  const discovery = await client.discoverWorkspace(manifest, condaPlatform);

  assert.equal(discovery.snapshotAvailable, true);
  assert.deepEqual(discovery.info, {
    manifest,
    name: 'demo',
    lockfileStatus: 'out-of-date',
    lockfileReason: 'feature test changed',
  });
  assert.deepEqual(discovery.declaredEnvironments, [
    {
      name: 'test',
      features: ['test'],
      installed: true,
      condaDependencies: ['python'],
    },
    {
      name: 'docs',
      features: ['docs'],
      installed: false,
      condaDependencies: ['sphinx'],
    },
  ]);
  assert.equal(discovery.environments.length, 1);
  assert.deepEqual(discovery.environments[0]?.directDependencies, [
    {
      name: 'python',
      pypi: false,
      location: { feature: 'test' },
      table: '[feature.test.dependencies]',
    },
  ]);
  assert.deepEqual(discovery.environments[0]?.python, {
    version: '3.13.5',
    executable:
      process.platform === 'win32'
        ? path.join(prefix, 'python.exe')
        : path.join(prefix, 'bin', 'python'),
  });
  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [['workspace', '--file', manifest, 'info', '--json', '--packages']],
  );
});

test('getWorkspaceSnapshot returns declared environments and rich platform resolutions', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const response = {
    manifest,
    name: 'demo',
    environment_details: [
      {
        name: 'analysis',
        features: ['cuda'],
        platforms: ['linux-base', 'linux-cuda'],
        prefix: path.resolve('/work/project/.conda/envs/analysis'),
        installed: false,
        resolutions: [
          {
            platform: 'linux-base',
            subdir: 'linux-64',
            conda_dependencies: {},
            pypi_dependencies: {},
          },
          {
            platform: 'linux-cuda',
            subdir: 'linux-64',
            conda_dependencies: {},
            pypi_dependencies: {},
          },
        ],
        packages: [],
      },
    ],
  };
  const runner = new RecordingRunner(() => success(response));
  const client = new CondaWorkspacesClient({ runner });

  assert.deepEqual(await client.getWorkspaceSnapshot(manifest), {
    manifest,
    name: 'demo',
    environments: [
      {
        name: 'analysis',
        features: ['cuda'],
        platforms: ['linux-base', 'linux-cuda'],
        prefix: path.resolve('/work/project/.conda/envs/analysis'),
        installed: false,
        resolutions: [
          { platform: 'linux-base', subdir: 'linux-64', dependencies: [] },
          { platform: 'linux-cuda', subdir: 'linux-64', dependencies: [] },
        ],
        packages: [],
      },
    ],
  });
  assert.deepEqual(runner.calls[0]?.args, [
    'workspace',
    '--file',
    manifest,
    'info',
    '--json',
    '--packages',
  ]);
});

test('workspace image preview preserves declared platform and every command argument', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const runner = new RecordingRunner(() =>
    success({
      recipe: 'FROM debian:bookworm-slim\nCMD ["python", "", " spaced "]\n',
      files: ['conda.toml', 'src/app.py'],
    }),
  );
  const client = new CondaWorkspacesClient({
    runner,
    condaExecutable: '_conda',
  }) as CondaWorkspacesClient & {
    previewWorkspaceImage?: (
      manifest: string,
      environment: string,
      platform: string,
      imageOptions: {
        readonly tag: string;
        readonly command: readonly string[];
        readonly load?: boolean;
        readonly output?: string;
      },
    ) => Promise<unknown>;
  };

  assert.equal(typeof client.previewWorkspaceImage, 'function');
  assert.deepEqual(
    await client.previewWorkspaceImage?.(manifest, 'runtime', 'linux-arm-one', {
      tag: 'example:latest',
      command: ['python', '', ' spaced ', '--message=hello world'],
      load: true,
    }),
    {
      recipe: 'FROM debian:bookworm-slim\nCMD ["python", "", " spaced "]\n',
      files: ['conda.toml', 'src/app.py'],
    },
  );
  assert.deepEqual(runner.calls[0], {
    executable: '_conda',
    args: [
      'workspace',
      '--file',
      manifest,
      'image',
      '-e',
      'runtime',
      '--platform',
      'linux-arm-one',
      '--tag',
      'example:latest',
      '--load',
      '--dry-run',
      '--json',
      '--',
      'python',
      '',
      ' spaced ',
      '--message=hello world',
    ],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: path.dirname(manifest),
    },
  });
});

test('workspace image preview supports one OCI output destination', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const output = path.resolve('/work/project/example.oci.tar');
  const runner = new RecordingRunner(() => success({ recipe: 'FROM base\n', files: [] }));
  const client = new CondaWorkspacesClient({ runner }) as CondaWorkspacesClient & {
    previewWorkspaceImage?: (
      manifest: string,
      environment: string,
      platform: string,
      imageOptions: {
        readonly tag: string;
        readonly command: readonly string[];
        readonly output: string;
      },
    ) => Promise<unknown>;
  };

  assert.equal(typeof client.previewWorkspaceImage, 'function');
  await client.previewWorkspaceImage?.(manifest, 'runtime', 'linux-64', {
    tag: 'example:v1',
    command: ['python', 'app.py'],
    output,
  });

  assert.deepEqual(runner.calls[0]?.args, [
    'workspace',
    '--file',
    manifest,
    'image',
    '-e',
    'runtime',
    '--platform',
    'linux-64',
    '--tag',
    'example:v1',
    '--output',
    output,
    '--dry-run',
    '--json',
    '--',
    'python',
    'app.py',
  ]);
});

test('discoverWorkspace uses environment platform order for rich host resolutions', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const condaPlatform = process.platform === 'win32' ? 'win-64' : 'linux-64';
  const dependency = (name: string, platform: string) => ({
    platform,
    subdir: condaPlatform,
    conda_dependencies: {
      [name]: {
        spec: name,
        provenance: {
          table: `[target.${platform}.dependencies]`,
          location: { platform },
        },
      },
    },
    pypi_dependencies: {},
  });
  const runner = new RecordingRunner(() =>
    success({
      manifest,
      name: 'demo',
      environment_details: [
        {
          name: 'default',
          features: [],
          platforms: ['host-base', 'host-accelerated'],
          prefix: path.resolve('/work/project/.conda/envs/default'),
          installed: true,
          resolutions: [
            dependency('accelerated', 'host-accelerated'),
            dependency('base', 'host-base'),
          ],
          packages: [],
        },
      ],
    }),
  );

  const discovery = await new CondaWorkspacesClient({ runner }).discoverWorkspace(
    manifest,
    condaPlatform,
  );

  assert.deepEqual(
    discovery.environments[0]?.directDependencies.map(({ name }) => name),
    ['base'],
  );
});

test('discoverWorkspace falls back when the snapshot command is unavailable', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const prefix = path.resolve('/work/project/.conda/envs/default');
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command.endsWith('info --json --packages')) {
      return {
        exitCode: 2,
        stdout: '',
        stderr:
          'usage: conda workspace [-h] [--file MANIFEST_FILE] ...\n' +
          'conda workspace: error: unrecognized arguments: --packages',
      };
    }
    if (command.endsWith('info --json')) {
      return success({ manifest, name: 'demo' });
    }
    if (command.endsWith('envs --json')) {
      return success([{ name: 'default', features: [], installed: true }]);
    }
    if (command.endsWith('info -e default --json')) {
      return success(environmentInfo('default', prefix, 1));
    }
    if (command.endsWith('list -e default --json')) {
      return success([{ name: 'python', version: '3.13.5', build: 'h1_0' }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({ runner });

  const discovery = await client.discoverWorkspace(manifest, 'linux-64');
  const secondDiscovery = await client.discoverWorkspace(manifest, 'linux-64');

  assert.equal(discovery.snapshotAvailable, false);
  assert.equal(secondDiscovery.snapshotAvailable, false);
  assert.deepEqual(
    runner.calls.map(({ args }) => args.slice(3)),
    [
      ['info', '--json', '--packages'],
      ['info', '--json'],
      ['envs', '--json'],
      ['info', '-e', 'default', '--json'],
      ['list', '-e', 'default', '--json'],
      ['info', '--json'],
      ['envs', '--json'],
      ['info', '-e', 'default', '--json'],
      ['list', '-e', 'default', '--json'],
    ],
  );
  assert.equal(runner.calls.filter(({ args }) => args.includes('--packages')).length, 1);
  client.resetCapabilityCache();
  await client.discoverWorkspace(manifest, 'linux-64');
  assert.equal(runner.calls.filter(({ args }) => args.includes('--packages')).length, 2);
});

test('discoverWorkspace does not retry manifest validation through legacy discovery', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const runner = new RecordingRunner(() => ({
    exitCode: 1,
    stdout: JSON.stringify({
      exception_name: 'WorkspaceParseError',
      error_message: `Failed to parse workspace manifest '${manifest}': invalid channel`,
      message: `Failed to parse workspace manifest '${manifest}': invalid channel`,
      path: manifest,
      reason: 'invalid channel',
    }),
    stderr: '',
  }));
  const client = new CondaWorkspacesClient({ runner });

  await assert.rejects(client.discoverWorkspace(manifest, 'linux-64'), /invalid channel/);
  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [['workspace', '--file', manifest, 'info', '--json', '--packages']],
  );
});

test('discoverWorkspace does not retry a pyproject without workspace tables', async () => {
  const manifest = path.resolve('/work/project/pyproject.toml');
  const runner = new RecordingRunner(() => ({
    exitCode: 1,
    stdout: JSON.stringify({
      exception_name: 'WorkspaceParseError',
      path: manifest,
      reason: 'No [tool.conda.workspace] or [tool.pixi.workspace] table found',
      message: `Failed to parse workspace manifest '${manifest}'`,
    }),
    stderr: '',
  }));
  const client = new CondaWorkspacesClient({ runner });

  await assert.rejects(client.discoverWorkspace(manifest, 'linux-64'), /workspace manifest/);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]?.args, [
    'workspace',
    '--file',
    manifest,
    'info',
    '--json',
    '--packages',
  ]);
});

test('discoverInstalledEnvironments combines metadata and marks Python', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const defaultPrefix = path.resolve('/work/.conda/default');
  const docsPrefix = path.resolve('/work/.conda/docs');
  const condaPlatform = process.platform === 'win32' ? 'win-64' : 'linux-64';
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command.endsWith('envs --json')) {
      return success([
        { name: 'default', features: [], installed: true },
        { name: 'docs', features: ['docs'], installed: true },
        { name: 'unused', features: ['unused'], installed: false },
      ]);
    }
    if (command.endsWith('info -e default --json')) {
      return success(environmentInfo('default', defaultPrefix, 2));
    }
    if (command.endsWith('list -e default --json')) {
      return success([
        { name: 'python', version: '3.12.12', build: 'h123_0' },
        { name: 'numpy', version: '2.4.1', build: 'py312_0' },
      ]);
    }
    if (command.endsWith('info -e docs --json')) {
      return success({
        ...environmentInfo('docs', docsPrefix, 1),
        pypi_dependencies: { myst_parser: '>=4' },
      });
    }
    if (command.endsWith('list -e docs --json')) {
      return success([{ name: 'sphinx', version: '8.2.0', build: 'pyhd8ed1ab_0' }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({ runner });

  const discovery = await client.discoverInstalledEnvironments(manifest, condaPlatform);
  const environments = discovery.environments;

  assert.equal(environments.length, 2);
  assert.deepEqual(discovery.failures, []);
  assert.deepEqual(environments[0]?.python, {
    version: '3.12.12',
    executable:
      process.platform === 'win32'
        ? path.join(defaultPrefix, 'python.exe')
        : path.join(defaultPrefix, 'bin', 'python'),
  });
  assert.equal(environments[1]?.python, null);
  assert.deepEqual(environments[1]?.features, ['docs']);
  assert.deepEqual(environments[1]?.directDependencies, [
    { name: 'python', pypi: false },
    { name: 'myst_parser', pypi: true },
  ]);
  assert.equal(
    runner.calls.some(({ args }) => args.includes('unused')),
    false,
  );
});

test('discoverWorkspace retries the snapshot after a transient failure', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  let snapshotCalls = 0;
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command.endsWith('info --json --packages')) {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? { exitCode: 1, stdout: '', stderr: 'temporary workspace failure' }
        : success({ manifest, name: 'demo', environment_details: [] });
    }
    if (command.endsWith('info --json')) {
      return success({ manifest, name: 'demo' });
    }
    if (command.endsWith('envs --json')) {
      return success([]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({ runner });

  assert.equal((await client.discoverWorkspace(manifest, 'linux-64')).snapshotAvailable, false);
  assert.equal((await client.discoverWorkspace(manifest, 'linux-64')).snapshotAvailable, true);
  assert.equal(snapshotCalls, 2);
});

test('discoverInstalledEnvironments retains healthy siblings when one environment fails', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const defaultPrefix = path.resolve('/work/.conda/default');
  const brokenPrefix = path.resolve('/work/.conda/broken');
  const condaPlatform = process.platform === 'win32' ? 'win-64' : 'linux-64';
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command.endsWith('envs --json')) {
      return success([
        { name: 'default', features: [], installed: true },
        { name: 'broken', features: ['broken'], installed: true },
      ]);
    }
    if (command.endsWith('info -e default --json')) {
      return success(environmentInfo('default', defaultPrefix, 1));
    }
    if (command.endsWith('list -e default --json')) {
      return success([{ name: 'python', version: '3.13.5', build: 'h1_0' }]);
    }
    if (command.endsWith('info -e broken --json')) {
      return success(environmentInfo('broken', brokenPrefix, 1));
    }
    if (command.endsWith('list -e broken --json')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'broken prefix',
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({ runner });

  const discovery = await client.discoverInstalledEnvironments(manifest, condaPlatform);

  assert.deepEqual(
    discovery.environments.map(({ name }) => name),
    ['default'],
  );
  assert.equal(discovery.failures.length, 1);
  assert.equal(discovery.failures[0]?.environmentName, 'broken');
  assert.equal(discovery.failures[0]?.prefix, brokenPrefix);
  assert.match(String(discovery.failures[0]?.error), /broken prefix/);
});

test('mutation methods build scoped, non-interactive commands', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const runner = new RecordingRunner(() => success());
  const client = new CondaWorkspacesClient({ runner });

  await client.installEnvironment(manifest, 'test');
  await client.installLockedEnvironment(manifest, 'locked');
  await client.updateLockfile(manifest);
  await client.cleanEnvironment(manifest, 'test');
  await client.addDependencies(manifest, ['pytest>=9'], {
    noInstall: true,
    feature: 'test',
  });
  await client.removeDependencies(manifest, ['ruff'], {
    environment: 'test',
    platform: 'linux-64',
    pypi: true,
  });
  await client.updateDependencies(manifest, ['numpy>=2'], {
    feature: 'test',
    platform: 'linux-64',
  });
  assert.throws(
    () => client.updateDependencies(manifest, ['build>=1'], { pypi: true }),
    /does not support PyPI dependencies/,
  );

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      ['workspace', '--file', manifest, 'install', '--yes', '--json', '-e', 'test'],
      ['workspace', '--file', manifest, 'install', '--yes', '--json', '--locked', '-e', 'locked'],
      ['workspace', '--file', manifest, 'lock', '--yes', '--json'],
      ['workspace', '--file', manifest, 'clean', '--yes', '--json', '-e', 'test'],
      [
        'workspace',
        '--file',
        manifest,
        'add',
        '--yes',
        '--json',
        '--feature',
        'test',
        '--no-install',
        '--',
        'pytest>=9',
      ],
      [
        'workspace',
        '--file',
        manifest,
        'remove',
        '--yes',
        '--json',
        '--pypi',
        '--environment',
        'test',
        '--platform',
        'linux-64',
        '--',
        'ruff',
      ],
      [
        'workspace',
        '--file',
        manifest,
        'update',
        '--yes',
        '--json',
        '--feature',
        'test',
        '--platform',
        'linux-64',
        '--',
        'numpy>=2',
      ],
    ],
  );
});

test('environment declaration methods keep lifecycle arguments separate', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const definition = path.resolve('/work/import/environment.yml');
  const runner = new RecordingRunner(() => success());
  const client = new CondaWorkspacesClient({ runner });

  await client.addEnvironment(manifest, 'analysis', {
    features: ['test', 'cuda'],
    noDefaultFeature: true,
  });
  await client.importEnvironment(manifest, 'legacy', definition);
  await client.removeEnvironmentDeclaration(manifest, 'analysis');

  assert.deepEqual(
    runner.calls.map(({ args, options }) => ({ args, cwd: options?.cwd })),
    [
      {
        args: [
          'workspace',
          '--file',
          manifest,
          'add',
          '--yes',
          '--json',
          '-e',
          'analysis',
          '--with-feature',
          'test',
          '--with-feature',
          'cuda',
          '--no-default-feature',
        ],
        cwd: path.dirname(manifest),
      },
      {
        args: [
          'workspace',
          '--file',
          manifest,
          'import',
          '--yes',
          '--json',
          '-e',
          'legacy',
          definition,
        ],
        cwd: path.dirname(manifest),
      },
      {
        args: [
          'workspace',
          '--file',
          manifest,
          'remove',
          '--yes',
          '--json',
          '-e',
          'analysis',
          '--all',
        ],
        cwd: path.dirname(manifest),
      },
    ],
  );
});

test('workspace SBOM export keeps manifest, destination, and rich platform arguments separate', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const destination = path.resolve('/work/output/analysis.cdx.json');
  const runner = new RecordingRunner(() => success());
  const client = new CondaWorkspacesClient({ runner });

  await client.exportWorkspaceSbom(manifest, 'analysis', 'linux-cuda', destination, {
    reproducible: true,
  });

  assert.deepEqual(runner.calls[0], {
    executable: 'conda',
    args: [
      'workspace',
      '--file',
      manifest,
      'sbom',
      '--environment',
      'analysis',
      '--platform',
      'linux-cuda',
      '--file',
      destination,
      '--json',
      '--reproducible',
    ],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: path.dirname(manifest),
    },
  });
});

test('workspace SBOM export preserves a multiline structured backend error', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const destination = path.resolve('/work/output/analysis.cdx.json');
  const backendMessage =
    'CycloneDX export requires exact package records.\n' +
    'Export an environment after generating a current lockfile.';
  const runner = new RecordingRunner((_executable, args) =>
    args.includes('--json')
      ? {
          exitCode: 1,
          stdout: JSON.stringify({
            success: false,
            exception_name: 'CondaValueError',
            message: backendMessage,
          }),
          stderr: '',
        }
      : {
          exitCode: 1,
          stdout: '',
          stderr:
            '╭─ Error ───────────────────────────────────────────╮\n' +
            '│ CycloneDX export requires exact package records. │\n' +
            '│ Export an environment after generating a current │\n' +
            '╰───────────────────────────────────────────────────╯',
        },
  );
  const client = new CondaWorkspacesClient({ runner });

  await assert.rejects(
    client.exportWorkspaceSbom(manifest, 'analysis', 'linux-cuda', destination),
    (error: unknown) => {
      assert.equal((error as Error).message, `conda failed with ${backendMessage}`);
      return true;
    },
  );
  assert.deepEqual(runner.calls[0]?.args, [
    'workspace',
    '--file',
    manifest,
    'sbom',
    '--environment',
    'analysis',
    '--platform',
    'linux-cuda',
    '--file',
    destination,
    '--json',
  ]);
});

test('quickstart runs in the target directory and parses its JSON result', async () => {
  const workspaceDirectory = path.resolve('/work/new');
  const runner = new RecordingRunner(() =>
    success({
      workspace: '/work/new',
      environment: 'default',
      manifest: 'conda.toml',
      specs_added: ['python=3.12', 'numpy'],
      shell_spawned: false,
    }),
  );
  const client = new CondaWorkspacesClient({ runner });

  const result = await client.quickstart(workspaceDirectory, {
    specs: ['python=3.12', 'numpy'],
    format: 'conda',
  });

  assert.deepEqual(result, {
    environment: 'default',
    manifest: 'conda.toml',
  });
  assert.deepEqual(runner.calls[0], {
    executable: 'conda',
    args: [
      'workspace',
      'quickstart',
      '--yes',
      '--json',
      '--no-shell',
      '--format',
      'conda',
      '--',
      'python=3.12',
      'numpy',
    ],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: workspaceDirectory,
    },
  });
});

test('nonzero conda exits include the command error', async () => {
  const failure = {
    exitCode: 2,
    stdout: '',
    stderr: 'Workspace not found\nMore detail',
  };
  const runner = new RecordingRunner(() => failure);
  const client = new CondaWorkspacesClient({ runner });

  await assert.rejects(client.listEnvironments('/work/conda.toml'), /Workspace not found/);
});
