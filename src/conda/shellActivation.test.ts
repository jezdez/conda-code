import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { condaShellCommands } from './shellActivation';

test('conda shell activation uses the configured root', () => {
  const rootPrefix = path.resolve('/opt/custom conda');
  const environmentPrefix = path.resolve('/work/project/.conda');
  const commands = condaShellCommands(rootPrefix, environmentPrefix);

  assert.deepEqual(commands.shellActivation?.get('bash'), [
    {
      executable: 'source',
      args: [path.join(rootPrefix, 'etc', 'profile.d', 'conda.sh')],
    },
    {
      executable: 'conda',
      args: ['activate', environmentPrefix],
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
