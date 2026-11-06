import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PythonEnvironments } from '@vscode/python-environments';
import { debug, extensions, Uri, workspace } from 'vscode';

async function readProbeWhenWritten(
  file: string,
  action: () => Promise<void>,
): Promise<{ prefix: string; executable: string; condaPrefix?: string }> {
  let dispose = () => {};
  const result = new Promise<{ prefix: string; executable: string; condaPrefix?: string }>(
    (resolve, reject) => {
      const watcher = watch(path.dirname(file), () => {
        void read();
      });
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error(`Timed out waiting for ${file}`));
      }, 30000);
      dispose = () => {
        clearTimeout(timer);
        watcher.close();
      };
      watcher.on('error', reject);
      const read = async () => {
        try {
          const value = JSON.parse(await readFile(file, 'utf8'));
          clearTimeout(timer);
          watcher.close();
          resolve(value);
        } catch {
          /* File may not exist yet or still be writing. */
        }
      };
      void read();
    },
  );
  try {
    const [value] = await Promise.all([result, action()]);
    return value;
  } finally {
    dispose();
  }
}

// Run via VS Code's --extensionTestsPath, never in the unit-test process.
export async function run(): Promise<void> {
  const prefix = process.env.CONDA_CODE_TEST_PREFIX;
  assert.ok(prefix, 'Set CONDA_CODE_TEST_PREFIX to an existing, runnable conda environment');
  const folder = workspace.workspaceFolders?.[0];
  assert.ok(folder, 'Open a disposable workspace in an isolated VS Code profile');
  assert.equal(
    workspace.getConfiguration('python-envs').get('terminal.autoActivationType'),
    'command',
    'Set python-envs.terminal.autoActivationType to command in the isolated profile',
  );
  assert.equal(
    workspace.getConfiguration('python-envs').get('packageWatchers', true),
    true,
    'Enable python-envs.packageWatchers in the isolated profile',
  );
  const extension = extensions.getExtension('jezdez.conda-code');
  assert.ok(extension);
  await extension.activate();
  assert.ok(extension.isActive);

  const api = await PythonEnvironments.api();
  const environments = await api.getEnvironments('all');
  const expectedPrefix = await realpath(prefix);
  const environment = environments.find(
    (item) =>
      item.envId.managerId === 'jezdez.conda-code:conda' && item.environmentPath.fsPath === prefix,
  );
  assert.ok(environment, `Conda Code did not discover ${prefix}`);
  const previous = await api.getEnvironment(folder.uri);
  const scratch = await mkdtemp(path.join(folder.uri.fsPath, 'conda-code-probe-'));
  const errors: unknown[] = [];
  try {
    await api.setEnvironment(folder.uri, environment);
    assert.equal((await api.getEnvironment(folder.uri))?.envId.id, environment.envId.id);
    const packages = await api.getPackages(environment);
    assert.ok(Array.isArray(packages));
    const child = await api.runInBackground(environment, {
      args: [
        '-c',
        'import sys,json; print(json.dumps(dict(executable=sys.executable,prefix=sys.prefix)))',
      ],
      cwd: folder.uri.fsPath,
    });
    let stdout = '';
    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Python probe timed out'));
      }, 15000);
      child.onExit((code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Python exited ${code}`));
      });
    });
    const result = JSON.parse(stdout.trim()) as { prefix: string; executable: string };
    assert.equal(await realpath(result.prefix), expectedPrefix);
    assert.equal(
      await realpath(result.executable),
      await realpath(environment.execInfo.run.executable),
    );
    const script = path.join(scratch, 'probe.py');
    await writeFile(
      script,
      'import sys, os, json\nwith open(sys.argv[1] if len(sys.argv) > 1 else os.environ["CONDA_CODE_PROBE_OUTPUT"], "w") as output:\n    json.dump(dict(executable=sys.executable, prefix=sys.prefix, condaPrefix=os.environ.get("CONDA_PREFIX")), output)\n',
    );
    const terminalFile = path.join(scratch, 'terminal.json');
    const terminal = await api.createTerminal(environment, {
      name: 'Conda Code integration',
      cwd: folder.uri.fsPath,
      env: {
        PATH:
          process.platform === 'win32'
            ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
            : '/usr/bin:/bin',
        CONDA_PREFIX: null,
        CONDA_DEFAULT_ENV: null,
        CONDA_SHLVL: '0',
        CONDA_CODE_PROBE_SCRIPT: script,
        CONDA_CODE_PROBE_OUTPUT: terminalFile,
      },
      ...(process.platform === 'win32'
        ? {}
        : { shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'] }),
    });
    try {
      const value = await readProbeWhenWritten(terminalFile, async () => {
        terminal.show();
        terminal.sendText(
          `python -c "import os,runpy;runpy.run_path(os.environ['CONDA_CODE_PROBE_SCRIPT'])"`,
        );
      });
      assert.equal(await realpath(value.prefix), expectedPrefix);
      assert.equal(
        await realpath(value.executable),
        await realpath(environment.execInfo.run.executable),
      );
      assert.ok(
        value.condaPrefix,
        'Terminal must be activated, not merely use an absolute Python path',
      );
      assert.equal(await realpath(value.condaPrefix), expectedPrefix);
      console.log('Conda Code terminal activation passed');
    } finally {
      terminal.dispose();
    }

    const debuggerExtension = extensions.getExtension('ms-python.debugpy');
    assert.ok(debuggerExtension, 'Install ms-python.debugpy in the isolated extensions directory');
    await debuggerExtension.activate();
    const debugFile = path.join(scratch, 'debug.json');
    const name = `Conda Code integration ${path.basename(scratch)}`;
    try {
      const value = await readProbeWhenWritten(debugFile, async () => {
        assert.ok(
          await debug.startDebugging(folder, {
            name,
            type: 'debugpy',
            request: 'launch',
            program: script,
            args: [debugFile],
            console: 'internalConsole',
            justMyCode: true,
          }),
          'Debug session must start',
        );
      });
      assert.equal(await realpath(value.prefix), expectedPrefix);
      assert.equal(
        await realpath(value.executable),
        await realpath(environment.execInfo.run.executable),
      );
      console.log('Conda Code debug interpreter selection passed');
    } finally {
      if (debug.activeDebugSession?.name === name)
        await debug.stopDebugging(debug.activeDebugSession);
    }

    const fixture = path.join(scratch, 'watch-prefix');
    const metadata = path.join(fixture, 'conda-meta');
    await mkdir(metadata, { recursive: true });
    const interpreter = path.join(
      fixture,
      process.platform === 'win32' ? 'python.exe' : 'bin/python',
    );
    await mkdir(path.dirname(interpreter), { recursive: true });
    // A metadata-only prefix: never execute this placeholder or mutate the supplied environment.
    await writeFile(interpreter, '');
    await writeFile(path.join(metadata, 'history'), '');
    await writeFile(
      path.join(metadata, 'python-3.12.0-0.json'),
      JSON.stringify({
        name: 'python',
        version: '3.12.0',
        build: '0',
        build_number: 0,
        subdir:
          process.platform === 'win32'
            ? 'win-64'
            : process.platform === 'darwin'
              ? 'osx-arm64'
              : 'linux-64',
        channel: 'conda-forge',
        files: [],
      }),
    );
    const watched = await api.resolveEnvironment(Uri.file(fixture));
    assert.equal(watched?.envId.managerId, 'jezdez.conda-code:conda');
    assert.ok(watched);
    await api.setEnvironment(folder.uri, watched);
    await api.getPackages(watched);
    let disposeChange = () => {};
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error('Package watcher did not publish the added package'));
      }, 15000);
      const subscription = api.onDidChangePackages((event) => {
        if (
          event.environment.envId.id === watched.envId.id &&
          event.changes.some(
            (change) => change.kind === 'add' && change.pkg.name === 'conda-code-watch-probe',
          )
        ) {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        }
      });
      disposeChange = () => {
        clearTimeout(timer);
        subscription.dispose();
      };
    });
    try {
      await Promise.all([
        changed,
        writeFile(
          path.join(metadata, 'conda-code-watch-probe-1.0-0.json'),
          JSON.stringify({
            name: 'conda-code-watch-probe',
            version: '1.0',
            build: '0',
            build_number: 0,
            channel: 'conda-forge',
            subdir: 'noarch',
            files: [],
          }),
        ),
      ]);
    } finally {
      disposeChange();
    }
    assert.ok(
      (await api.getPackages(watched))?.some((pkg) => pkg.name === 'conda-code-watch-probe'),
    );
    console.log('Conda Code external metadata package watcher passed');
  } catch (error) {
    errors.push(error);
  }
  try {
    await api.setEnvironment(folder.uri, previous);
  } catch (error) {
    errors.push(error);
  }
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Conda Code integration failed');
  console.log(
    'Conda Code integration passed: activation, packages, background, terminal, debug, and watcher',
  );
}
