import { PythonEnvironments } from '@vscode/python-environments';
import { commands, Disposable, ExtensionContext, Uri, window, workspace } from 'vscode';

import { CondaWorkspaceEnvironmentManager } from './conda/environmentManager';
import { CondaWorkspacePackageManager } from './conda/packageManager';
import { CondaWorkspaceSelectionState } from './conda/selectionState';
import { CondaWorkspacesClient } from './conda/workspaces';

const MANIFEST_WATCH_PATTERN = '**/{conda.toml,pixi.toml,pyproject.toml,conda.lock}';
const REFRESH_DELAY_MS = 150;

interface CondaCodeRuntime extends Disposable {
  readonly environments: CondaWorkspaceEnvironmentManager;
  readonly packages: CondaWorkspacePackageManager;
}

function configuredCondaExecutable(): string {
  const configured = workspace
    .getConfiguration('conda-code')
    .get<string>('condaExecutable')
    ?.trim();
  if (configured) {
    return configured;
  }

  const activeConda = process.env.CONDA_EXE?.trim();
  if (activeConda) {
    return activeConda;
  }

  const pythonCondaPath = workspace.getConfiguration('python').get<string>('condaPath')?.trim();
  return pythonCondaPath || 'conda';
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function activate(context: ExtensionContext): Promise<void> {
  const api = await PythonEnvironments.api();
  const log = window.createOutputChannel('Conda Code', { log: true });
  const selectionState = new CondaWorkspaceSelectionState(context.workspaceState);
  const managerId = `${context.extension.id}:conda-workspaces`;
  let runtime: CondaCodeRuntime | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const startRuntime = (): CondaCodeRuntime => {
    runtime?.dispose();

    const condaExecutable = configuredCondaExecutable();
    const client = new CondaWorkspacesClient({ condaExecutable });
    const environments = new CondaWorkspaceEnvironmentManager(
      api,
      client,
      selectionState,
      managerId,
      { log },
    );
    const packages = new CondaWorkspacePackageManager(api, client, environments, {
      log,
    });
    const packageRegistration = api.registerPackageManager(packages, {
      extensionId: context.extension.id,
    });
    const environmentRegistration = api.registerEnvironmentManager(environments, {
      extensionId: context.extension.id,
    });

    log.info(`Registered ${managerId} using ${condaExecutable}`);
    return {
      environments,
      packages,
      dispose: () => {
        environmentRegistration.dispose();
        packageRegistration.dispose();
        packages.dispose();
        environments.dispose();
      },
    };
  };

  const refresh = async (scope?: Uri): Promise<void> => {
    const current = runtime;
    if (current === undefined) {
      return;
    }

    try {
      await current.packages.clearCache();
      await current.environments.refresh(scope);
    } catch (error) {
      log.error(`Refresh failed: ${messageFromError(error)}`);
    }
  };

  const scheduleRefresh = (scope?: Uri): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh(scope);
    }, REFRESH_DELAY_MS);
  };

  runtime = startRuntime();
  const watcher = workspace.createFileSystemWatcher(MANIFEST_WATCH_PATTERN);

  context.subscriptions.push(
    log,
    watcher,
    watcher.onDidCreate(scheduleRefresh),
    watcher.onDidChange(scheduleRefresh),
    watcher.onDidDelete(scheduleRefresh),
    commands.registerCommand('conda-code.refresh', () => refresh()),
    workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('conda-code.condaExecutable') &&
        !event.affectsConfiguration('python.condaPath')
      ) {
        return;
      }
      runtime = startRuntime();
      void refresh();
    }),
    new Disposable(() => {
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
      runtime?.dispose();
      runtime = undefined;
    }),
  );

  await refresh();
}

export function deactivate(): void {
  // VS Code disposes the extension context subscriptions.
}
