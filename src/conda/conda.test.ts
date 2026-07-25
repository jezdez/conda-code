import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CondaClient } from './conda';
import { type CommandResult, type CommandRunner, type RunCommandOptions } from './runner';

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

function success(value: unknown = {}): CommandResult {
  return {
    exitCode: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function condaInfo(): object {
  return {
    platform: 'linux-64',
    conda_version: '26.5.3',
    root_prefix: '/opt/conda',
    conda_prefix: '/opt/conda',
    envs_dirs: ['/opt/conda/envs'],
    default_prefix: '/opt/conda',
    active_prefix: null,
    active_prefix_name: null,
    envs: ['/opt/conda'],
    envs_details: { '/opt/conda': { name: 'base' } },
  };
}

test('regular conda reads use the configured executable and JSON contracts', async () => {
  const runner = new RecordingRunner((_executable, args) => {
    if (args[0] === 'info') {
      return success(condaInfo());
    }
    return success([
      {
        name: 'python',
        version: '3.13.5',
        build_string: 'h123_0',
        channel: 'conda-forge',
      },
    ]);
  });
  const client = new CondaClient({
    runner,
    condaExecutable: '_conda',
    maxOutputBytes: 2048,
  });

  const info = await client.getInfo();
  const packages = await client.listPrefixPackages('/envs/a path');

  assert.equal(info.rootPrefix, '/opt/conda');
  assert.deepEqual(packages, [
    {
      name: 'python',
      version: '3.13.5',
      build: 'h123_0',
      channel: 'conda-forge',
    },
  ]);
  assert.deepEqual(runner.calls, [
    {
      executable: '_conda',
      args: ['info', '--json'],
      options: { signal: undefined, maxOutputBytes: 2048 },
    },
    {
      executable: '_conda',
      args: ['list', '--prefix', '/envs/a path', '--json', '--no-pip'],
      options: { signal: undefined, maxOutputBytes: 2048 },
    },
  ]);
});

test('derived clients run through the owning conda executable', async () => {
  const runner = new RecordingRunner(() => success([]));
  const configured = new CondaClient({
    runner,
    condaExecutable: 'conda',
    maxOutputBytes: 2048,
  });
  const owner = configured.forExecutable('_conda');

  assert.equal(configured.executable, 'conda');
  assert.equal(owner.executable, '_conda');
  assert.equal(configured.forExecutable('conda'), configured);
  await owner.listPrefixPackages('/owner/envs/demo');

  assert.deepEqual(runner.calls, [
    {
      executable: '_conda',
      args: ['list', '--prefix', '/owner/envs/demo', '--json', '--no-pip'],
      options: { signal: undefined, maxOutputBytes: 2048 },
    },
  ]);
});

test('regular conda reads exclude pip loaders and preserve conda-pypi records', async () => {
  const runner = new RecordingRunner(() =>
    success([
      {
        name: 'raw-pip-package',
        version: '1.0',
        build_string: 'pypi_0',
        channel: 'pypi',
        platform: 'pypi',
      },
      {
        name: 'conda-pypi-package',
        version: '1.0',
        build_string: 'pypi_0',
        channel: 'conda-pypi',
        platform: 'noarch',
      },
    ]),
  );
  const client = new CondaClient({ runner });

  assert.deepEqual(await client.listPrefixPackages('/envs/demo'), [
    {
      name: 'conda-pypi-package',
      version: '1.0',
      build: 'pypi_0',
      channel: 'conda-pypi',
      platform: 'noarch',
    },
  ]);
});

test('regular conda mutations keep every value in its own process argument', async () => {
  const runner = new RecordingRunner((_executable, args) =>
    args[0] === 'create'
      ? success({ actions: { PREFIX: args.includes('--name') ? '/envs/demo' : '/work/.conda' } })
      : success(),
  );
  const client = new CondaClient({ runner });

  assert.equal(
    await client.createNamedEnvironment('demo', ['python=3.13', 'value; untouched']),
    '/envs/demo',
  );
  assert.equal(
    await client.createPrefixEnvironment('/work/.conda', ['python', '$(not-a-shell)']),
    '/work/.conda',
  );
  await client.installPackages('/envs/demo', ['numpy>=2'], { upgrade: true });
  await client.removePackages('/envs/demo', ['--all']);
  await client.removeEnvironment('/envs/demo');

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      ['create', '--yes', '--json', '--name', 'demo', '--', 'python=3.13', 'value; untouched'],
      ['create', '--yes', '--json', '--prefix', '/work/.conda', '--', 'python', '$(not-a-shell)'],
      ['install', '--yes', '--json', '--prefix', '/envs/demo', '--update-specs', '--', 'numpy>=2'],
      ['remove', '--yes', '--json', '--prefix', '/envs/demo', '--', '--all'],
      ['remove', '--yes', '--json', '--all', '--prefix', '/envs/demo'],
    ],
  );
});

test('regular conda installs do not upgrade satisfied specs unless requested', async () => {
  const runner = new RecordingRunner(() => success());
  const client = new CondaClient({
    runner,
    condaExecutable: 'C:\\Miniforge3\\Scripts\\CONDA.EXE',
  });

  await client.installPackages('/envs/demo', ['numpy']);

  assert.deepEqual(runner.calls[0]?.args, [
    'install',
    '--yes',
    '--json',
    '--prefix',
    '/envs/demo',
    '--satisfied-skip-solve',
    '--',
    'numpy',
  ]);
});

test('Conda clients reject non-conda executables before running a command', () => {
  const runner = new RecordingRunner(() => success());
  for (const executable of [
    '/opt/tools/bin/solver',
    'C:\\tools\\conda.bat',
    'C:\\tools\\SOLVER.BAT',
    'C:\\tools\\PYTHON.EXE',
  ]) {
    assert.throws(
      () => new CondaClient({ runner, condaExecutable: executable }),
      /must invoke conda/,
    );
  }
  const conda = new CondaClient({ runner, condaExecutable: 'conda' });
  assert.throws(() => conda.forExecutable('/opt/tools/bin/solver'), /must invoke conda/);
  assert.deepEqual(runner.calls, []);
});

test('environment file creation uses a named target and the project directory', async () => {
  const createdPrefix = path.resolve('/opt/conda/envs/demo');
  const runner = new RecordingRunner(() => success({ actions: { PREFIX: createdPrefix } }));
  const client = new CondaClient({ runner });
  const environmentFile = path.resolve('/work/demo/environment.yml');

  assert.equal(await client.createEnvironmentFromFile(environmentFile, 'demo'), createdPrefix);
  assert.deepEqual(runner.calls[0], {
    executable: 'conda',
    args: ['create', '--yes', '--json', '--name', 'demo', '--file', environmentFile],
    options: {
      signal: undefined,
      maxOutputBytes: 4 * 1024 * 1024,
      cwd: path.dirname(environmentFile),
    },
  });
});

test('lockfile creation disables configured default packages', async () => {
  const runner = new RecordingRunner(() => success({ prefix: '/opt/conda/envs/demo' }));
  const client = new CondaClient({ runner });
  const explicitFile = path.resolve('/work/demo/explicit.txt');

  await client.createEnvironmentFromFile(explicitFile, 'demo', {
    noDefaultPackages: true,
  });

  assert.deepEqual(runner.calls[0]?.args, [
    'create',
    '--yes',
    '--json',
    '--name',
    'demo',
    '--no-default-packages',
    '--file',
    explicitFile,
  ]);
});

test('regular conda failures include the command error', async () => {
  const failure: CommandResult = {
    exitCode: 1,
    stdout: '',
    stderr: 'PackagesNotFoundError: missing\nmore detail',
  };
  const client = new CondaClient({ runner: new RecordingRunner(() => failure) });

  await assert.rejects(client.installPackages('/envs/demo', ['missing']), /PackagesNotFoundError/);
});

test('regular conda failures use the structured JSON message', async () => {
  const failure: CommandResult = {
    exitCode: 1,
    stdout: JSON.stringify({
      error: "CondaValueError: 'base' is a reserved environment name",
      message: "'base' is a reserved environment name",
    }),
    stderr: 'WARNING unrelated warning',
  };
  const client = new CondaClient({ runner: new RecordingRunner(() => failure) });

  await assert.rejects(
    client.createNamedEnvironment('root', ['python']),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("'base' is a reserved environment name") &&
      !error.message.includes('unrelated warning'),
  );
});

test('regular conda mutations reject empty values before spawning', async () => {
  const runner = new RecordingRunner(() => success());
  const client = new CondaClient({ runner });

  await assert.rejects(client.createNamedEnvironment(' ', ['python']), /name must not be empty/);
  await assert.rejects(client.installPackages('/envs/demo', []), /specs must not be empty/);
  assert.equal(runner.calls.length, 0);
});
