import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandCancelledError, CommandOutputLimitError, SpawnCommandRunner } from './runner';

test('SpawnCommandRunner captures stdout, stderr, and the exit code', async () => {
  const runner = new SpawnCommandRunner();
  const result = await runner.run(process.execPath, [
    '-e',
    ["process.stdout.write('out')", "process.stderr.write('err')", 'process.exitCode = 7'].join(
      '\n',
    ),
  ]);

  assert.deepEqual(result, {
    exitCode: 7,
    stdout: 'out',
    stderr: 'err',
  });
});

test('SpawnCommandRunner passes argument metacharacters without a shell', async () => {
  const runner = new SpawnCommandRunner();
  const metacharacters = 'value; echo should-not-run';
  const result = await runner.run(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    metacharacters,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, metacharacters);
});

test('SpawnCommandRunner rejects and stops output beyond the byte limit', async () => {
  const runner = new SpawnCommandRunner();

  await assert.rejects(
    runner.run(process.execPath, ['-e', "process.stdout.write('0123456789')"], {
      maxOutputBytes: 5,
    }),
    CommandOutputLimitError,
  );
});

test('SpawnCommandRunner cancels an active child process', async () => {
  const runner = new SpawnCommandRunner();
  const controller = new AbortController();
  const running = runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(running, CommandCancelledError);
});

test('SpawnCommandRunner does not spawn when already cancelled', async () => {
  const runner = new SpawnCommandRunner();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runner.run(process.execPath, ['--version'], {
      signal: controller.signal,
    }),
    CommandCancelledError,
  );
});
