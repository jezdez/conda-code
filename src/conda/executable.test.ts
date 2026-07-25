import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  condaExecutableCandidatePaths,
  locateCondaExecutablePath,
  resolveCondaExecutablePath,
} from './executable';

test('keeps the lexical PATH executable distinct from its symlink target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('file symlinks require additional privileges on Windows');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-executable-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const target = path.join(root, 'installation', 'bin', 'conda');
  const executable = path.join(bin, 'conda');
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(path.dirname(target), { recursive: true }),
  ]);
  await writeFile(target, '');
  await symlink(target, executable);

  assert.equal(await locateCondaExecutablePath('conda', { PATH: bin }), executable);
  assert.equal(await resolveCondaExecutablePath('conda', { PATH: bin }), await realpath(target));
});

test('checks higher-priority PATH candidates before the current conda executable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'conda-code-executable-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstBin = path.join(root, 'first', 'bin');
  const secondBin = path.join(root, 'second', 'bin');
  const executableName = process.platform === 'win32' ? 'conda.exe' : 'conda';
  const first = path.join(firstBin, executableName);
  const second = path.join(secondBin, executableName);
  await Promise.all([mkdir(firstBin, { recursive: true }), mkdir(secondBin, { recursive: true })]);
  await writeFile(second, '');
  const environment = {
    PATH: [firstBin, secondBin].join(path.delimiter),
    ...(process.platform === 'win32' ? { PATHEXT: '.EXE' } : {}),
  };

  assert.deepEqual(
    condaExecutableCandidatePaths('conda', environment).filter((candidate) =>
      [first, second].includes(candidate),
    ),
    [first, second],
  );
  assert.equal(await locateCondaExecutablePath('conda', environment), second);
  await writeFile(first, '');
  assert.equal(await locateCondaExecutablePath('conda', environment), first);
});
