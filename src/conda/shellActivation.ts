import path from 'node:path';

import type {
  PythonCommandRunConfiguration,
  PythonEnvironmentExecutionInfo,
} from '@vscode/python-environments';

export function condaShellCommands(
  rootPrefix: string,
  identifier: string,
): Pick<PythonEnvironmentExecutionInfo, 'shellActivation' | 'shellDeactivation'> {
  const pathFlavor =
    process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(rootPrefix) ? path.win32 : path;
  const condaSh = pathFlavor.join(rootPrefix, 'etc', 'profile.d', 'conda.sh');
  const condaFish = pathFlavor.join(rootPrefix, 'etc', 'fish', 'conf.d', 'conda.fish');
  const condaPowerShell = pathFlavor.join(rootPrefix, 'shell', 'condabin', 'conda-hook.ps1');
  const condaBatch = pathFlavor.join(rootPrefix, 'Scripts', 'activate.bat');
  const activate: PythonCommandRunConfiguration = {
    executable: 'conda',
    args: ['activate', identifier],
  };
  const deactivate: PythonCommandRunConfiguration[] = [
    { executable: 'conda', args: ['deactivate'] },
  ];
  const bashActivation: PythonCommandRunConfiguration[] = [
    { executable: 'source', args: [condaSh] },
    activate,
  ];
  const gitBashActivation: PythonCommandRunConfiguration[] = [
    { executable: 'source', args: [condaSh.replaceAll('\\', '/')] },
    activate,
  ];
  const shellActivation = new Map<string, PythonCommandRunConfiguration[]>([
    ['bash', bashActivation],
    ['zsh', bashActivation],
    ['gitbash', gitBashActivation],
    ['sh', [{ executable: '.', args: [condaSh] }, activate]],
    ['fish', [{ executable: 'source', args: [condaFish] }, activate]],
    ['pwsh', [{ executable: '&', args: [condaPowerShell] }, activate]],
    ['cmd', [{ executable: condaBatch, args: [identifier] }]],
  ]);
  return {
    shellActivation,
    shellDeactivation: new Map([...shellActivation.keys()].map((shell) => [shell, deactivate])),
  };
}
