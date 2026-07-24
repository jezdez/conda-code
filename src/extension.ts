import { PythonEnvironments } from '@vscode/python-environments';
import { commands, Disposable, ExtensionContext, extensions, Uri, window, workspace } from 'vscode';

import { CondaClient } from './conda/conda';
import { CondaEnvironmentManager } from './conda/environmentManager';
import { isPixiProjectManifest } from './conda/manifestOwnership';
import { CondaPackageManager } from './conda/packageManager';
import { CondaSelectionState } from './conda/selectionState';
import { CondaWorkspacesClient } from './conda/workspaces';

const MANIFEST_WATCH_PATTERN = '**/{conda.toml,pixi.toml,pyproject.toml,conda.lock}';
const REFRESH_DELAY_MS = 150;
const PIXI_CODE_EXTENSION_ID = 'renan-r-santos.pixi-code';

interface CondaCodeRuntime extends Disposable {
  readonly environments: CondaEnvironmentManager;
  readonly packages: CondaPackageManager;
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
  const selectionState = new CondaSelectionState(context.workspaceState);
  const managerId = `${context.extension.id}:conda`;
  let runtime: CondaCodeRuntime | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const startRuntime = (): CondaCodeRuntime => {
    runtime?.dispose();

    const condaExecutable = configuredCondaExecutable();
    const conda = new CondaClient({ condaExecutable });
    const workspaces = new CondaWorkspacesClient({ condaExecutable });
    const environments = new CondaEnvironmentManager(
      api,
      conda,
      workspaces,
      selectionState,
      managerId,
      {
        log,
        shouldHandleManifest: async (manifest) => {
          if (extensions.getExtension(PIXI_CODE_EXTENSION_ID) === undefined) {
            return true;
          }
          if (isPixiProjectManifest(manifest.fsPath)) {
            return false;
          }
          if (!manifest.fsPath.toLocaleLowerCase().endsWith('pyproject.toml')) {
            return true;
          }
          try {
            const contents = new TextDecoder().decode(await workspace.fs.readFile(manifest));
            return !isPixiProjectManifest(manifest.fsPath, contents);
          } catch {
            return true;
          }
        },
      },
    );
    const packages = new CondaPackageManager(api, conda, workspaces, environments, {
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
