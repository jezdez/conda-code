import path from 'node:path';

import {
  CancellationToken,
  Disposable,
  LogOutputChannel,
  ProcessExecution,
  Task,
  TaskDefinition,
  TaskProvider,
  TaskScope,
  Uri,
  WorkspaceFolder,
  workspace,
} from 'vscode';

import { requireValue } from './conda';
import { isRunnableCondaExecutable } from './executable';
import { type WorkspaceTask, CondaWorkspacesClient } from './workspaces';
import { normalizeEnvironmentPath } from './workspaceRouting';

export const CONDA_WORKSPACE_TASK_TYPE = 'conda-workspace';

const MANIFEST_NAMES = ['conda.toml', 'pixi.toml', 'pyproject.toml'] as const;
const TASK_SOURCE = 'conda-workspaces';

export interface CondaWorkspaceTaskDefinition extends TaskDefinition {
  readonly type: typeof CONDA_WORKSPACE_TASK_TYPE;
  readonly task: string;
  readonly file: string;
}

export interface CondaWorkspaceTaskProviderOptions {
  readonly log?: LogOutputChannel;
  readonly listWorkspaceManifests: () => Promise<readonly Uri[]>;
  readonly selectedWorkspaceEnvironment?: (
    manifest: Uri,
  ) => string | undefined | Promise<string | undefined>;
}

interface DiscoveredManifestTasks {
  readonly manifest: Uri;
  readonly folder: WorkspaceFolder | undefined;
  readonly tasks: readonly WorkspaceTask[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkspaceFolder(scope: Task['scope']): scope is WorkspaceFolder {
  return typeof scope === 'object' && scope !== null && 'uri' in scope;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function portableRelativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export class CondaWorkspaceTaskProvider implements TaskProvider, Disposable {
  private readonly condaExecutable: string;
  private cachedTaskGroups: readonly DiscoveredManifestTasks[] | undefined;
  private taskDiscovery: Promise<readonly DiscoveredManifestTasks[]> | undefined;
  private discoveryController: AbortController | undefined;
  private generation = 0;

  public constructor(
    private readonly workspaces: CondaWorkspacesClient,
    condaExecutable: string,
    private readonly options: CondaWorkspaceTaskProviderOptions,
  ) {
    this.condaExecutable = requireValue(condaExecutable, 'condaExecutable');
    if (!isRunnableCondaExecutable(this.condaExecutable)) {
      throw new TypeError('condaExecutable must invoke conda directly');
    }
  }

  public async provideTasks(token: CancellationToken): Promise<Task[]> {
    if (token.isCancellationRequested) {
      return [];
    }
    const groups = await this.getTaskGroups();
    const tasks: Task[] = [];
    for (const group of groups) {
      if (token.isCancellationRequested) {
        return [];
      }
      const environment = await this.selectedWorkspaceEnvironment(group.manifest);
      tasks.push(
        ...group.tasks.map((task) =>
          this.createTask(group.manifest, task, group.folder, environment),
        ),
      );
    }
    return token.isCancellationRequested ? [] : tasks;
  }

  public async resolveTask(task: Task, token: CancellationToken): Promise<Task | undefined> {
    if (task.definition.type !== CONDA_WORKSPACE_TASK_TYPE || token.isCancellationRequested) {
      return undefined;
    }

    const taskName = stringProperty(task.definition.task);
    const file = stringProperty(task.definition.file);
    if (taskName === undefined || file === undefined) {
      return undefined;
    }

    const scope = task.scope;
    const folder = isWorkspaceFolder(scope)
      ? scope
      : workspace.workspaceFolders?.length === 1
        ? workspace.workspaceFolders[0]
        : undefined;
    const manifestPath = path.isAbsolute(file)
      ? path.resolve(file)
      : folder === undefined
        ? undefined
        : path.resolve(folder.uri.fsPath, file);
    if (
      manifestPath === undefined ||
      !MANIFEST_NAMES.includes(
        path.basename(manifestPath).toLowerCase() as (typeof MANIFEST_NAMES)[number],
      ) ||
      (folder !== undefined && !isPathWithin(folder.uri.fsPath, manifestPath))
    ) {
      return undefined;
    }

    const manifest = Uri.file(manifestPath);
    const workspaceManifests = await this.options.listWorkspaceManifests();
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (
      !workspaceManifests.some(
        (candidate) =>
          normalizeEnvironmentPath(candidate.fsPath) === normalizeEnvironmentPath(manifestPath),
      )
    ) {
      return undefined;
    }

    const environment = await this.selectedWorkspaceEnvironment(manifest);
    if (token.isCancellationRequested) {
      return undefined;
    }
    task.execution = this.execution(manifestPath, taskName, environment);
    return task;
  }

  public refresh(): void {
    this.generation += 1;
    this.cachedTaskGroups = undefined;
    this.taskDiscovery = undefined;
    this.discoveryController?.abort();
    this.discoveryController = undefined;
  }

  public dispose(): void {
    this.discoveryController?.abort();
  }

  private getTaskGroups(): Promise<readonly DiscoveredManifestTasks[]> {
    if (this.cachedTaskGroups !== undefined) {
      return Promise.resolve(this.cachedTaskGroups);
    }
    if (this.taskDiscovery !== undefined) {
      return this.taskDiscovery;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.discoveryController = controller;
    const discovery = this.discoverTaskGroups(controller.signal).then((groups) => {
      if (this.generation === generation) {
        this.cachedTaskGroups = groups;
      }
      return groups;
    });
    const trackedDiscovery = discovery.finally(() => {
      if (this.taskDiscovery === trackedDiscovery) {
        this.taskDiscovery = undefined;
        this.discoveryController = undefined;
      }
    });
    this.taskDiscovery = trackedDiscovery;
    return trackedDiscovery;
  }

  private async discoverTaskGroups(signal: AbortSignal): Promise<DiscoveredManifestTasks[]> {
    const manifests = await this.options.listWorkspaceManifests();
    if (signal.aborted) {
      return [];
    }

    const groups: DiscoveredManifestTasks[] = [];
    for (const manifest of manifests) {
      if (signal.aborted) {
        break;
      }
      try {
        const listing = await this.workspaces.listTasks(manifest.fsPath, { signal });
        if (signal.aborted) {
          break;
        }
        groups.push({
          manifest,
          folder: workspace.getWorkspaceFolder(manifest),
          tasks: listing.tasks.filter((task) => task.source !== 'user'),
        });
      } catch (error) {
        if (!signal.aborted) {
          this.options.log?.debug(
            `Could not inspect tasks in workspace manifest ${manifest.fsPath}: ${errorMessage(error)}`,
          );
        }
      }
    }
    return groups;
  }

  private createTask(
    manifest: Uri,
    workspaceTask: WorkspaceTask,
    folder: WorkspaceFolder | undefined,
    environment: string | undefined,
  ): Task {
    const file =
      folder !== undefined && isPathWithin(folder.uri.fsPath, manifest.fsPath)
        ? portableRelativePath(folder.uri.fsPath, manifest.fsPath)
        : manifest.fsPath;
    const definition: CondaWorkspaceTaskDefinition = {
      type: CONDA_WORKSPACE_TASK_TYPE,
      task: workspaceTask.name,
      file,
    };
    const task = new Task(
      definition,
      folder ?? TaskScope.Workspace,
      workspaceTask.name,
      TASK_SOURCE,
      this.execution(manifest.fsPath, workspaceTask.name, environment),
    );
    task.detail =
      workspaceTask.description === undefined ? file : `${workspaceTask.description} (${file})`;
    return task;
  }

  private execution(
    manifest: string,
    task: string,
    environment: string | undefined,
  ): ProcessExecution {
    const runArgs =
      environment === undefined
        ? ['run', '--', task]
        : ['run', `--environment=${environment}`, '--', task];
    return new ProcessExecution(this.condaExecutable, ['task', '--file', manifest, ...runArgs], {
      cwd: path.dirname(manifest),
    });
  }

  private async selectedWorkspaceEnvironment(manifest: Uri): Promise<string | undefined> {
    if (this.options.selectedWorkspaceEnvironment === undefined) {
      return undefined;
    }
    try {
      const selected = await this.options.selectedWorkspaceEnvironment(manifest);
      return selected === undefined ? undefined : stringProperty(selected);
    } catch (error) {
      this.options.log?.debug(
        `Could not resolve the selected workspace environment for ${manifest.fsPath}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }
}
