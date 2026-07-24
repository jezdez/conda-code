import assert from 'node:assert/strict';
import path from 'node:path';
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
    condaExecutable: '/custom/conda',
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
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'info', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'envs', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'info', '-e', 'default', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
      {
        executable: '/custom/conda',
        args: ['workspace', '--file', manifest, 'list', '-e', 'default', '--json'],
        cwd: path.dirname(manifest),
        maxOutputBytes: 1024,
      },
    ],
  );
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
      return success(environmentInfo('docs', docsPrefix, 1));
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
  assert.equal(
    runner.calls.some(({ args }) => args.includes('unused')),
    false,
  );
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
  assert.ok(discovery.failures[0]?.error instanceof CondaCommandError);
});

test('mutation methods build scoped, non-interactive commands', async () => {
  const manifest = path.resolve('/work/project/conda.toml');
  const runner = new RecordingRunner(() => success());
  const client = new CondaWorkspacesClient({ runner });

  await client.installEnvironment(manifest, 'test');
  await client.cleanEnvironment(manifest, 'test');
  await client.addDependencies(manifest, ['pytest>=9'], {
    noInstall: true,
    feature: 'test',
  });

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      ['workspace', '--file', manifest, 'install', '--yes', '-e', 'test'],
      ['workspace', '--file', manifest, 'clean', '--yes', '-e', 'test'],
      [
        'workspace',
        '--file',
        manifest,
        'add',
        '--yes',
        '--feature',
        'test',
        '--no-install',
        '--',
        'pytest>=9',
      ],
    ],
  );
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
