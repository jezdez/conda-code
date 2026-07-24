import assert from 'node:assert/strict';
import test from 'node:test';

import { condaShellCommands } from './shellActivation';

test('conda shell activation uses the configured POSIX root', () => {
  const commands = condaShellCommands('/opt/custom conda', '/work/project/.conda');

  assert.deepEqual(commands.shellActivation?.get('bash'), [
    {
      executable: 'source',
      args: ['/opt/custom conda/etc/profile.d/conda.sh'],
    },
    {
      executable: 'conda',
      args: ['activate', '/work/project/.conda'],
    },
  ]);
  assert.deepEqual(commands.shellDeactivation?.get('bash'), [
    { executable: 'conda', args: ['deactivate'] },
  ]);
});

test('conda shell activation converts Windows paths for Git Bash', () => {
  const commands = condaShellCommands(String.raw`C:\Miniconda3`, 'demo');

  assert.deepEqual(commands.shellActivation?.get('gitbash'), [
    {
      executable: 'source',
      args: ['C:/Miniconda3/etc/profile.d/conda.sh'],
    },
    {
      executable: 'conda',
      args: ['activate', 'demo'],
    },
  ]);
  assert.deepEqual(commands.shellActivation?.get('cmd'), [
    {
      executable: String.raw`C:\Miniconda3\Scripts\activate.bat`,
      args: ['demo'],
    },
  ]);
});
