import path from 'node:path';

import { PythonEnvironments } from '@vscode/python-environments';
import {
  commands,
  Disposable,
  ExtensionContext,
  extensions,
  ProgressLocation,
  RelativePattern,
  tasks as vscodeTasks,
  Uri,
  window,
  workspace,
} from 'vscode';

import { CondaClient, type CondaInfo } from './conda/conda';
import { CondaEnvironmentManager } from './conda/environmentManager';
import {
  condaInfoCoherenceFingerprint,
  isCachedCondaInfoCoherent,
  isCachedCondaInfoFresh,
  type CachedCondaInfo,
} from './conda/infoCache';
import { isPixiProjectManifest } from './conda/manifestOwnership';
import { CondaPackageManager } from './conda/packageManager';
import { CondaWorkspaceProjectFinder } from './conda/projects';
import { CondaSelectionState } from './conda/selectionState';
import {
  CONDA_WORKSPACE_TASK_TYPE,
  CondaWorkspaceTaskProvider,
  runWorkspaceTask,
} from './conda/tasks';
import { normalizeEnvironmentPath } from './conda/workspaceRouting';
import { CondaWorkspacesClient } from './conda/workspaces';

const MANIFEST_WATCH_PATTERN = '**/{conda.toml,pixi.toml,pyproject.toml,conda.lock}';
const REFRESH_DELAY_MS = 150;
const CONDA_INFO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONDA_INFO_CACHE_KEY = 'conda-code.condaInfo';
const PIXI_CODE_EXTENSION_ID = 'renan-r-santos.pixi-code';

interface CondaCodeRuntime extends Disposable {
  readonly environments: CondaEnvironmentManager;
  readonly packages: CondaPackageManager;
  readonly tasks: CondaWorkspaceTaskProvider;
  readonly forceCondaInfoEnrichment: () => Promise<void>;
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
  let scheduledScope: Uri | undefined;
  let scheduledInvalidateRegular = false;
  let scheduledForceCondaInfo = false;
  let condaInfoCacheWrites: Promise<void> = Promise.resolve();

  const updateCondaInfoCache = (value: CachedCondaInfo | undefined): Promise<void> => {
    const write = condaInfoCacheWrites
      .catch(() => undefined)
      .then(() => context.globalState.update(CONDA_INFO_CACHE_KEY, value));
    condaInfoCacheWrites = write.catch((error: unknown) => {
      log.debug(`Could not update cached conda information: ${messageFromError(error)}`);
    });
    return write;
  };

  const shouldHandleManifest = async (manifest: Uri): Promise<boolean> => {
    if (extensions.getExtension(PIXI_CODE_EXTENSION_ID) === undefined) {
      return true;
    }
    if (isPixiProjectManifest(manifest.fsPath)) {
      return false;
    }
    if (!manifest.fsPath.toLowerCase().endsWith('pyproject.toml')) {
      return true;
    }
    try {
      const contents = new TextDecoder().decode(await workspace.fs.readFile(manifest));
      return !isPixiProjectManifest(manifest.fsPath, contents);
    } catch {
      return true;
    }
  };

  const startRuntime = (): CondaCodeRuntime => {
    runtime?.dispose();

    const condaExecutable = configuredCondaExecutable();
    const conda = new CondaClient({ condaExecutable });
    const workspaces = new CondaWorkspacesClient({ condaExecutable });
    const storedCondaInfo = context.globalState.get<CachedCondaInfo>(CONDA_INFO_CACHE_KEY);
    const currentPath = process.env.PATH ?? process.env.Path ?? process.env.path;
    let cachedCondaInfo =
      storedCondaInfo?.executable === condaExecutable && storedCondaInfo.path === currentPath
        ? storedCondaInfo
        : undefined;
    let condaInfoInvalidation: Promise<void> = Promise.resolve();
    let disposed = false;
    let configurationWatcher = Disposable.from();

    const updateConfigurationWatcher = (info?: CondaInfo): void => {
      configurationWatcher.dispose();
      configurationWatcher = Disposable.from(
        ...[
          ...new Set(
            [...(info?.configFiles ?? []), info?.rcPath, info?.userRcPath, info?.sysRcPath].filter(
              (source): source is string => source !== undefined && source !== '',
            ),
          ),
        ].map((source) => {
          const watcher = workspace.createFileSystemWatcher(
            new RelativePattern(Uri.file(path.dirname(source)), path.basename(source)),
          );
          const refresh = (): void => scheduleRefresh(undefined, true, true);
          return Disposable.from(
            watcher,
            watcher.onDidCreate(refresh),
            watcher.onDidChange(refresh),
            watcher.onDidDelete(refresh),
          );
        }),
      );
    };

    const forceCondaInfoEnrichment = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      const stale =
        cachedCondaInfo === undefined ? undefined : { ...cachedCondaInfo, updatedAt: 0 };
      cachedCondaInfo = stale;
      const expiration =
        stale === undefined
          ? Promise.resolve()
          : updateCondaInfoCache(stale).catch((error: unknown) => {
              log.debug(`Could not expire cached conda information: ${messageFromError(error)}`);
            });
      condaInfoInvalidation = expiration;
      environments.invalidateCondaInfo();
      await expiration;
    };

    const environments = new CondaEnvironmentManager(
      api,
      conda,
      workspaces,
      selectionState,
      managerId,
      {
        log,
        shouldHandleManifest,
        ...(cachedCondaInfo === undefined ? {} : { initialCondaInfo: cachedCondaInfo.info }),
        enrichCondaInfo: async ({ force, signal }) => {
          if (force) {
            await condaInfoInvalidation;
          }
          if (signal.aborted) {
            return undefined;
          }
          if (
            !force &&
            isCachedCondaInfoFresh(cachedCondaInfo, Date.now(), CONDA_INFO_MAX_AGE_MS) &&
            cachedCondaInfo !== undefined
          ) {
            const currentFingerprint = await condaInfoCoherenceFingerprint(
              condaExecutable,
              cachedCondaInfo.info,
            );
            if (signal.aborted) {
              return undefined;
            }
            if (isCachedCondaInfoCoherent(cachedCondaInfo, currentFingerprint)) {
              return undefined;
            }
          }
          return conda.getInfo({ signal });
        },
        saveCondaInfo: async (info) => {
          if (info === undefined) {
            if (disposed) {
              return;
            }
            cachedCondaInfo = undefined;
            updateConfigurationWatcher();
            await updateCondaInfoCache(undefined);
            return;
          }
          updateConfigurationWatcher(info);
          if (disposed) {
            return;
          }
          const coherenceFingerprint = await condaInfoCoherenceFingerprint(condaExecutable, info);
          if (disposed) {
            return;
          }
          const nextCache: CachedCondaInfo = {
            executable: condaExecutable,
            path: currentPath,
            updatedAt: Date.now(),
            coherenceFingerprint,
            info,
          };
          cachedCondaInfo = nextCache;
          await updateCondaInfoCache(nextCache);
        },
      },
    );
    updateConfigurationWatcher(cachedCondaInfo?.info);
    const packages = new CondaPackageManager(api, conda, workspaces, environments, {
      log,
    });
    const packageRegistration = api.registerPackageManager(packages, {
      extensionId: context.extension.id,
    });
    const environmentRegistration = api.registerEnvironmentManager(environments, {
      extensionId: context.extension.id,
    });
    const projectFinderRegistration = api.registerPythonProjectCreator(
      new CondaWorkspaceProjectFinder(api, workspaces, { log, shouldHandleManifest }),
    );
    const taskProvider = new CondaWorkspaceTaskProvider(workspaces, condaExecutable, {
      log,
      listWorkspaceManifests: () => environments.getWorkspaceManifests(),
      selectedWorkspaceEnvironment: async (manifest) => {
        const selected = await api.getEnvironment(manifest);
        if (selected === undefined || selected.envId.managerId !== managerId) {
          return undefined;
        }
        const route = environments.getRoute(selected);
        return route !== undefined &&
          normalizeEnvironmentPath(route.manifestUri.fsPath) ===
            normalizeEnvironmentPath(manifest.fsPath)
          ? route.environmentName
          : undefined;
      },
    });
    const taskRegistration = vscodeTasks.registerTaskProvider(
      CONDA_WORKSPACE_TASK_TYPE,
      taskProvider,
    );

    log.info(`Registered ${managerId} using ${condaExecutable}`);
    return {
      environments,
      packages,
      tasks: taskProvider,
      forceCondaInfoEnrichment,
      dispose: () => {
        disposed = true;
        configurationWatcher.dispose();
        taskRegistration.dispose();
        projectFinderRegistration.dispose();
        environmentRegistration.dispose();
        packageRegistration.dispose();
        taskProvider.dispose();
        packages.dispose();
        environments.dispose();
      },
    };
  };

  const refresh = async (
    scope?: Uri,
    invalidateRegular = false,
    forceCondaInfo = false,
  ): Promise<void> => {
    const current = runtime;
    if (current === undefined) {
      return;
    }

    if (forceCondaInfo) {
      await current.forceCondaInfoEnrichment();
      if (runtime !== current) {
        return;
      }
    }
    current.tasks.refresh();
    try {
      if (invalidateRegular) {
        current.environments.invalidateRegularDiscovery();
      }
      current.packages.resetWorkspaceCapabilities();
      if (runtime !== current) {
        return;
      }
      await current.environments.refresh(scope);
      if (runtime !== current) {
        return;
      }
      await current.packages.refreshCachedPackages();
    } catch (error) {
      log.error(`Refresh failed: ${messageFromError(error)}`);
    } finally {
      if (runtime === current) {
        current.tasks.refresh();
      }
    }
  };

  const scheduleRefresh = (
    scope?: Uri,
    invalidateRegular = false,
    forceCondaInfo = false,
  ): void => {
    const projectScope = scope === undefined ? undefined : api.getPythonProject(scope)?.uri;
    if (refreshTimer === undefined) {
      scheduledScope = projectScope;
    } else if (
      projectScope === undefined ||
      scheduledScope === undefined ||
      projectScope.toString(true) !== scheduledScope.toString(true)
    ) {
      scheduledScope = undefined;
    }
    scheduledInvalidateRegular ||= invalidateRegular;
    scheduledForceCondaInfo ||= forceCondaInfo;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const nextScope = scheduledScope;
      const nextInvalidateRegular = scheduledInvalidateRegular;
      const nextForceCondaInfo = scheduledForceCondaInfo;
      scheduledScope = undefined;
      scheduledInvalidateRegular = false;
      scheduledForceCondaInfo = false;
      void refresh(nextScope, nextInvalidateRegular, nextForceCondaInfo);
    }, REFRESH_DELAY_MS);
  };

  const refreshImmediately = (): Promise<void> => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    scheduledScope = undefined;
    scheduledInvalidateRegular = false;
    scheduledForceCondaInfo = false;
    return refresh(undefined, true, true);
  };

  runtime = startRuntime();
  const watcher = workspace.createFileSystemWatcher(MANIFEST_WATCH_PATTERN);

  context.subscriptions.push(
    log,
    watcher,
    watcher.onDidCreate(scheduleRefresh),
    watcher.onDidChange(scheduleRefresh),
    watcher.onDidDelete(scheduleRefresh),
    api.onDidChangePythonProjects(() => scheduleRefresh()),
    commands.registerCommand('conda-code.refresh', refreshImmediately),
    commands.registerCommand('conda-code.runWorkspaceTask', (manifest?: Uri) =>
      runWorkspaceTask(runtime?.tasks, manifest ?? window.activeTextEditor?.document.uri),
    ),
    commands.registerCommand('conda-code.createEnvironmentFromFile', async (definition?: Uri) => {
      const source = definition ?? window.activeTextEditor?.document.uri;
      const current = runtime;
      if (source === undefined || current === undefined) {
        await window.showErrorMessage('Open a supported conda environment file first.');
        return;
      }

      try {
        const created = await window.withProgress(
          {
            location: ProgressLocation.Notification,
            title: `Creating an environment from ${path.basename(source.fsPath)}`,
          },
          async (progress) => {
            progress.report({ message: 'Conda is solving and installing packages' });
            return current.environments.createFromDefinitionFile(source);
          },
        );
        if (created !== undefined) {
          void window.showInformationMessage(
            `Created ${created.name} from ${path.basename(source.fsPath)}.`,
          );
        }
      } catch (error) {
        const message = messageFromError(error);
        log.error(`Environment creation failed: ${message}`);
        void window.showErrorMessage(`Could not create the conda environment: ${message}`);
      }
    }),
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
