import assert from 'node:assert/strict';
import test from 'node:test';

import { type CommandResult, type CommandRunner, type RunCommandOptions } from './runner';
import { CondaCommandError, CondaWorkspacesClient } from './workspaces';

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

function condaInfo(platform = 'linux-64'): object {
  return {
    platform,
    conda_version: '26.5.3',
    root_prefix: '/opt/conda',
    conda_prefix: '/opt/conda',
    envs_dirs: ['/opt/conda/envs'],
    default_prefix: '/opt/conda',
    active_prefix: null,
    active_prefix_name: null,
    envs: [],
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
  const manifest = '/work/project/conda.toml';
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
      return success(environmentInfo('default', '/work/.conda/default', 2));
    }
    if (command.endsWith('list -e default --json')) {
      return success([{ name: 'python', version: '3.12.12', build: 'h123_0' }]);
    }
    if (command.startsWith('task ')) {
      return success({ file: manifest, tasks: {} });
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({
    runner,
    condaExecutable: '/custom/conda',
    maxOutputBytes: 1024,
  });

  await client.getWorkspaceInfo(manifest);
  await client.listEnvironments(manifest);
  await client.getEnvironmentInfo(manifest, 'default');
  await client.listPackages(manifest, 'default');
  await client.listTasks(manifest);

  assert.deepEqual(
    runner.calls.map(({ executable, args, options }) => ({
      executable,
      args,
      cwd: options?.cwd,
      maxOutputBytes: options?.maxOutputBytes,
    })),
    [
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'info', '--json'],
        cwd: '/work/project',
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'envs', '--json'],
        cwd: '/work/project',
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'info', '-e', 'default', '--json'],
        cwd: '/work/project',
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'list', '-e', 'default', '--json'],
        cwd: '/work/project',
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['task', '--file', manifest, 'list', '--json'],
        cwd: '/work/project',
        maxOutputBytes: 1024,
      },
    ],
  );
});

test('discoverInstalledEnvironments combines metadata and marks Python', async () => {
  const manifest = '/work/project/conda.toml';
  const runner = new RecordingRunner((_executable, args) => {
    const command = args.join(' ');
    if (command === 'info --json') {
      return success(condaInfo());
    }
    if (command.endsWith('envs --json')) {
      return success([
        { name: 'default', features: [], installed: true },
        { name: 'docs', features: ['docs'], installed: true },
        { name: 'unused', features: ['unused'], installed: false },
      ]);
    }
    if (command.endsWith('info -e default --json')) {
      return success(environmentInfo('default', '/work/.conda/default', 2));
    }
    if (command.endsWith('list -e default --json')) {
      return success([
        { name: 'python', version: '3.12.12', build: 'h123_0' },
        { name: 'numpy', version: '2.4.1', build: 'py312_0' },
      ]);
    }
    if (command.endsWith('info -e docs --json')) {
      return success(environmentInfo('docs', '/work/.conda/docs', 1));
    }
    if (command.endsWith('list -e docs --json')) {
      return success([{ name: 'sphinx', version: '8.2.0', build: 'pyhd8ed1ab_0' }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = new CondaWorkspacesClient({ runner });

  const environments = await client.discoverInstalledEnvironments(manifest);

  assert.equal(environments.length, 2);
  assert.deepEqual(environments[0]?.python, {
    version: '3.12.12',
    executable: '/work/.conda/default/bin/python',
  });
  assert.equal(environments[1]?.python, null);
  assert.deepEqual(environments[1]?.features, ['docs']);
  assert.equal(
    runner.calls.some(({ args }) => args.includes('unused')),
    false,
  );
});

test('mutation methods build scoped, non-interactive commands', async () => {
  const manifest = '/work/project/conda.toml';
  const runner = new RecordingRunner(() => success());
  const client = new CondaWorkspacesClient({ runner });

  await client.installEnvironment(manifest, 'test', {
    forceReinstall: true,
    locked: true,
  });
  await client.cleanEnvironment(manifest, 'test');
  await client.addDependencies(manifest, ['pytest>=9'], {
    environment: 'test',
    noInstall: true,
  });
  await client.addDependencies(manifest, ['rich>=14'], {
    environment: 'test',
    pypi: true,
  });
  await client.removeDependencies(manifest, ['pytest'], {
    environment: 'test',
    noLockfileUpdate: true,
  });
  await client.runTask(manifest, 'check', ['--verbose'], {
    environment: 'test',
    skipDependencies: true,
  });

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      [
        'workspace',
        '--file',
        manifest,
        'install',
        '--yes',
        '-e',
        'test',
        '--force-reinstall',
        '--locked',
      ],
      ['workspace', '--file', manifest, 'clean', '--yes', '-e', 'test'],
      [
        'workspace',
        '--file',
        manifest,
        'add',
        '--yes',
        '-e',
        'test',
        '--no-install',
        '--',
        'pytest>=9',
      ],
      ['workspace', '--file', manifest, 'add', '--yes', '-e', 'test', '--pypi', '--', 'rich>=14'],
      [
        'workspace',
        '--file',
        manifest,
        'remove',
        '--yes',
        '-e',
        'test',
        '--no-lockfile-update',
        '--',
        'pytest',
      ],
      ['task', '--file', manifest, 'run', '-e', 'test', '--skip-deps', '--', 'check', '--verbose'],
    ],
  );
});

test('quickstart runs in the target directory and parses its JSON result', async () => {
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

  const result = await client.quickstart('/work/new', {
    specs: ['python=3.12', 'numpy'],
    name: 'demo',
    channels: ['conda-forge'],
    platforms: ['linux-64'],
  });

  assert.deepEqual(result.specsAdded, ['python=3.12', 'numpy']);
  assert.deepEqual(runner.calls[0], {
    executable: 'conda',
    args: [
      'workspace',
      'quickstart',
      '--yes',
      '--json',
      '--no-shell',
      '--name',
      'demo',
      '--channel',
      'conda-forge',
      '--platform',
      'linux-64',
      '--',
      'python=3.12',
      'numpy',
    ],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: '/work/new',
    },
  });
});

test('nonzero conda exits include the captured result', async () => {
  const failure = {
    exitCode: 2,
    stdout: '',
    stderr: 'Workspace not found\nMore detail',
  };
  const runner = new RecordingRunner(() => failure);
  const client = new CondaWorkspacesClient({ runner });

  await assert.rejects(
    client.listEnvironments('/work/conda.toml'),
    (error: unknown) =>
      error instanceof CondaCommandError &&
      error.result === failure &&
      error.message.includes('Workspace not found'),
  );
});
