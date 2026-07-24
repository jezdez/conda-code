import { dirname, posix, resolve, win32 } from 'node:path';

import {
  type CondaInfo,
  parseCondaInfo,
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
  parseWorkspaceTaskList,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentInfo,
  type WorkspaceInfo,
  type WorkspacePackage,
  type WorkspaceQuickstartResult,
  type WorkspaceTaskList,
} from './parsers';
import {
  type CommandResult,
  type CommandRunner,
  DEFAULT_MAX_OUTPUT_BYTES,
  type RunCommandOptions,
  SpawnCommandRunner,
} from './runner';

export type {
  CondaInfo,
  WorkspaceEnvironment,
  WorkspaceEnvironmentInfo,
  WorkspaceInfo,
  WorkspacePackage,
  WorkspaceQuickstartResult,
  WorkspaceTask,
  WorkspaceTaskList,
} from './parsers';

export interface CondaOperationOptions {
  readonly signal?: AbortSignal;
}

export interface CondaWorkspacesClientOptions {
  readonly runner?: CommandRunner;
  readonly condaExecutable?: string;
  readonly maxOutputBytes?: number;
}

export interface InstallEnvironmentOptions extends CondaOperationOptions {
  readonly forceReinstall?: boolean;
  readonly locked?: boolean;
  readonly frozen?: boolean;
  readonly noLock?: boolean;
}

export type WorkspaceManifestFormat = 'conda' | 'pixi' | 'pyproject';

export interface QuickstartOptions extends CondaOperationOptions {
  readonly specs?: readonly string[];
  readonly environment?: string;
  readonly format?: WorkspaceManifestFormat;
  readonly name?: string;
  readonly channels?: readonly string[];
  readonly platforms?: readonly string[];
  readonly forceReinstall?: boolean;
  readonly locked?: boolean;
  readonly frozen?: boolean;
}

export interface DependencyChangeOptions extends CondaOperationOptions {
  readonly environment?: string;
  readonly feature?: string;
  readonly pypi?: boolean;
  readonly noInstall?: boolean;
  readonly noLockfileUpdate?: boolean;
  readonly forceReinstall?: boolean;
}

export interface RunTaskOptions extends CondaOperationOptions {
  readonly environment?: string;
  readonly cleanEnvironment?: boolean;
  readonly skipDependencies?: boolean;
  readonly taskCwd?: string;
}

export interface WorkspacePython {
  readonly version: string;
  readonly executable: string;
}

export interface InstalledWorkspaceEnvironment extends WorkspaceEnvironmentInfo {
  readonly features: readonly string[];
  readonly packages: readonly WorkspacePackage[];
  readonly python: WorkspacePython | null;
}

export class CondaCommandError extends Error {
  public readonly executable: string;
  public readonly args: readonly string[];
  public readonly result: CommandResult;

  public constructor(executable: string, args: readonly string[], result: CommandResult) {
    const detail =
      firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit code ${result.exitCode}`;
    super(`${executable} failed with ${detail}`);
    this.name = 'CondaCommandError';
    this.executable = executable;
    this.args = args;
    this.result = result;
  }
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim().slice(0, 500);
  return line === '' ? undefined : line;
}

function requireValue(value: string, label: string): string {
  if (value.trim() === '') {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function absoluteManifestPath(manifest: string): string {
  return resolve(requireValue(manifest, 'manifest'));
}

function pythonExecutable(prefix: string, condaPlatform: string): string {
  return condaPlatform.startsWith('win-')
    ? win32.join(prefix, 'python.exe')
    : posix.join(prefix, 'bin', 'python');
}

export class CondaWorkspacesClient {
  private readonly runner: CommandRunner;
  private readonly condaExecutable: string;
  private readonly maxOutputBytes: number;

  public constructor(options: CondaWorkspacesClientOptions = {}) {
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.condaExecutable = requireValue(options.condaExecutable ?? 'conda', 'condaExecutable');
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new RangeError('maxOutputBytes must be a positive safe integer');
    }
  }

  public async getCondaInfo(options: CondaOperationOptions = {}): Promise<CondaInfo> {
    const result = await this.runChecked(['info', '--json'], options);
    return parseCondaInfo(result.stdout);
  }

  public async getWorkspaceInfo(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceInfo> {
    const result = await this.runWorkspace(manifest, ['info', '--json'], options);
    return parseWorkspaceInfo(result.stdout);
  }

  public async listEnvironments(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<readonly WorkspaceEnvironment[]> {
    const result = await this.runWorkspace(manifest, ['envs', '--json'], options);
    return parseWorkspaceEnvironments(result.stdout);
  }

  public async getEnvironmentInfo(
    manifest: string,
    environment: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceEnvironmentInfo> {
    const result = await this.runWorkspace(
      manifest,
      ['info', '-e', requireValue(environment, 'environment'), '--json'],
      options,
    );
    return parseWorkspaceEnvironmentInfo(result.stdout);
  }

  public async listPackages(
    manifest: string,
    environment: string,
    options: CondaOperationOptions = {},
  ): Promise<readonly WorkspacePackage[]> {
    const result = await this.runWorkspace(
      manifest,
      ['list', '-e', requireValue(environment, 'environment'), '--json'],
      options,
    );
    return parseWorkspacePackages(result.stdout);
  }

  public async listTasks(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceTaskList> {
    const manifestPath = absoluteManifestPath(manifest);
    const result = await this.runChecked(
      ['task', '--file', manifestPath, 'list', '--json'],
      options,
      dirname(manifestPath),
    );
    return parseWorkspaceTaskList(result.stdout);
  }

  public async discoverInstalledEnvironments(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<readonly InstalledWorkspaceEnvironment[]> {
    const [condaInfo, environments] = await Promise.all([
      this.getCondaInfo(options),
      this.listEnvironments(manifest, options),
    ]);

    return Promise.all(
      environments
        .filter((environment) => environment.installed)
        .map(async (environment) => {
          const [info, packages] = await Promise.all([
            this.getEnvironmentInfo(manifest, environment.name, options),
            this.listPackages(manifest, environment.name, options),
          ]);
          const pythonPackage = packages.find(
            (workspacePackage) => workspacePackage.name.toLocaleLowerCase() === 'python',
          );
          return {
            ...info,
            features: environment.features,
            packages,
            python:
              pythonPackage === undefined
                ? null
                : {
                    version: pythonPackage.version,
                    executable: pythonExecutable(info.prefix, condaInfo.platform),
                  },
          };
        }),
    );
  }

  public installEnvironment(
    manifest: string,
    environment?: string,
    options: InstallEnvironmentOptions = {},
  ): Promise<CommandResult> {
    const args = ['install', '--yes'];
    if (environment !== undefined) {
      args.push('-e', requireValue(environment, 'environment'));
    }
    if (options.forceReinstall === true) {
      args.push('--force-reinstall');
    }
    if (options.locked === true) {
      args.push('--locked');
    }
    if (options.frozen === true) {
      args.push('--frozen');
    }
    if (options.noLock === true) {
      args.push('--no-lock');
    }
    return this.runWorkspace(manifest, args, options);
  }

  public cleanEnvironment(
    manifest: string,
    environment?: string,
    options: CondaOperationOptions = {},
  ): Promise<CommandResult> {
    const args = ['clean', '--yes'];
    if (environment !== undefined) {
      args.push('-e', requireValue(environment, 'environment'));
    }
    return this.runWorkspace(manifest, args, options);
  }

  public async quickstart(
    directory: string,
    options: QuickstartOptions = {},
  ): Promise<WorkspaceQuickstartResult> {
    const args = ['workspace', 'quickstart', '--yes', '--json', '--no-shell'];
    if (options.environment !== undefined) {
      args.push('-e', requireValue(options.environment, 'environment'));
    }
    if (options.format !== undefined) {
      args.push('--format', options.format);
    }
    if (options.name !== undefined) {
      args.push('--name', requireValue(options.name, 'name'));
    }
    for (const channel of options.channels ?? []) {
      args.push('--channel', requireValue(channel, 'channel'));
    }
    for (const platform of options.platforms ?? []) {
      args.push('--platform', requireValue(platform, 'platform'));
    }
    if (options.forceReinstall === true) {
      args.push('--force-reinstall');
    }
    if (options.locked === true) {
      args.push('--locked');
    }
    if (options.frozen === true) {
      args.push('--frozen');
    }
    if ((options.specs?.length ?? 0) > 0) {
      args.push('--', ...(options.specs ?? []));
    }

    const result = await this.runChecked(
      args,
      options,
      resolve(requireValue(directory, 'directory')),
    );
    return parseWorkspaceQuickstartResult(result.stdout);
  }

  public addDependencies(
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions = {},
  ): Promise<CommandResult> {
    return this.changeDependencies('add', manifest, specs, options);
  }

  public removeDependencies(
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions = {},
  ): Promise<CommandResult> {
    return this.changeDependencies('remove', manifest, specs, options);
  }

  public runTask(
    manifest: string,
    task: string,
    taskArgs: readonly string[] = [],
    options: RunTaskOptions = {},
  ): Promise<CommandResult> {
    const manifestPath = absoluteManifestPath(manifest);
    const args = ['task', '--file', manifestPath, 'run'];
    if (options.environment !== undefined) {
      args.push('-e', requireValue(options.environment, 'environment'));
    }
    if (options.cleanEnvironment === true) {
      args.push('--clean-env');
    }
    if (options.skipDependencies === true) {
      args.push('--skip-deps');
    }
    if (options.taskCwd !== undefined) {
      args.push('--cwd', resolve(options.taskCwd));
    }
    args.push('--', requireValue(task, 'task'), ...taskArgs);
    return this.runChecked(args, options, dirname(manifestPath));
  }

  private changeDependencies(
    action: 'add' | 'remove',
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions,
  ): Promise<CommandResult> {
    if (specs.length === 0) {
      throw new TypeError('specs must contain at least one dependency');
    }
    const args = [action, '--yes'];
    if (options.environment !== undefined) {
      args.push('-e', requireValue(options.environment, 'environment'));
    }
    if (options.feature !== undefined) {
      args.push('--feature', requireValue(options.feature, 'feature'));
    }
    if (options.pypi === true) {
      args.push('--pypi');
    }
    if (options.noInstall === true) {
      args.push('--no-install');
    }
    if (options.noLockfileUpdate === true) {
      args.push('--no-lockfile-update');
    }
    if (options.forceReinstall === true) {
      args.push('--force-reinstall');
    }
    args.push('--', ...specs);
    return this.runWorkspace(manifest, args, options);
  }

  private runWorkspace(
    manifest: string,
    args: readonly string[],
    options: CondaOperationOptions,
  ): Promise<CommandResult> {
    const manifestPath = absoluteManifestPath(manifest);
    return this.runChecked(
      ['workspace', '--file', manifestPath, ...args],
      options,
      dirname(manifestPath),
    );
  }

  private async runChecked(
    args: readonly string[],
    options: CondaOperationOptions,
    cwd?: string,
  ): Promise<CommandResult> {
    const runnerOptions: RunCommandOptions = {
      signal: options.signal,
      maxOutputBytes: this.maxOutputBytes,
      ...(cwd === undefined ? {} : { cwd }),
    };
    const result = await this.runner.run(this.condaExecutable, args, runnerOptions);
    if (result.exitCode !== 0) {
      throw new CondaCommandError(this.condaExecutable, args, result);
    }
    return result;
  }
}
