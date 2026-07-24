import { dirname, posix, resolve, win32 } from 'node:path';

import { CondaClient, type CondaClientOperationOptions, requireValue } from './conda';
import {
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
  parseWorkspaceTasks,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentInfo,
  type WorkspaceInfo,
  type WorkspacePackage,
  type WorkspaceQuickstartResult,
  type WorkspaceTaskList,
} from './parsers';
import { type CommandResult } from './runner';

export type {
  WorkspaceEnvironment,
  WorkspaceEnvironmentInfo,
  WorkspaceInfo,
  WorkspacePackage,
  WorkspaceQuickstartResult,
  WorkspaceTask,
  WorkspaceTaskList,
} from './parsers';
export { CondaCommandError } from './conda';

export type CondaOperationOptions = CondaClientOperationOptions;

export type WorkspaceManifestFormat = 'conda' | 'pixi' | 'pyproject';

export interface QuickstartOptions extends CondaOperationOptions {
  readonly specs?: readonly string[];
  readonly format?: WorkspaceManifestFormat;
}

export interface DependencyChangeOptions extends CondaOperationOptions {
  readonly feature?: string;
  readonly noInstall?: boolean;
}

export interface WorkspacePython {
  readonly version: string;
  readonly executable: string;
}

export interface InstalledWorkspaceEnvironment extends WorkspaceEnvironmentInfo {
  readonly features: readonly string[];
  readonly python: WorkspacePython | null;
}

export interface FailedWorkspaceEnvironmentDiscovery {
  readonly environmentName: string;
  readonly prefix?: string;
  readonly error: unknown;
}

export interface InstalledWorkspaceEnvironmentDiscovery {
  readonly environments: readonly InstalledWorkspaceEnvironment[];
  readonly failures: readonly FailedWorkspaceEnvironmentDiscovery[];
}

function absoluteManifestPath(manifest: string): string {
  return resolve(requireValue(manifest, 'manifest'));
}

function pythonExecutable(prefix: string, condaPlatform: string): string {
  return condaPlatform.startsWith('win-')
    ? win32.join(prefix, 'python.exe')
    : posix.join(prefix, 'bin', 'python');
}

export class CondaWorkspacesClient extends CondaClient {
  public async listTasks(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceTaskList> {
    const result = await this.runTask(manifest, ['list', '--json'], options);
    return parseWorkspaceTasks(result.stdout);
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

  public async discoverInstalledEnvironments(
    manifest: string,
    condaPlatform: string,
    options: CondaOperationOptions = {},
  ): Promise<InstalledWorkspaceEnvironmentDiscovery> {
    const platform = requireValue(condaPlatform, 'condaPlatform');
    const environments = (await this.listEnvironments(manifest, options)).filter(
      (environment) => environment.installed,
    );
    const results = await Promise.all(
      environments.map(async (environment) => {
        const [infoResult, packagesResult] = await Promise.allSettled([
          this.getEnvironmentInfo(manifest, environment.name, options),
          this.listPackages(manifest, environment.name, options),
        ]);
        if (infoResult.status === 'rejected') {
          return {
            failure: {
              environmentName: environment.name,
              error: infoResult.reason,
            },
          };
        }
        if (packagesResult.status === 'rejected') {
          return {
            failure: {
              environmentName: environment.name,
              prefix: infoResult.value.prefix,
              error: packagesResult.reason,
            },
          };
        }

        const info = infoResult.value;
        const pythonPackage = packagesResult.value.find(
          (workspacePackage) => workspacePackage.name.toLowerCase() === 'python',
        );
        return {
          environment: {
            ...info,
            features: environment.features,
            python:
              pythonPackage === undefined
                ? null
                : {
                    version: pythonPackage.version,
                    executable: pythonExecutable(info.prefix, platform),
                  },
          },
        };
      }),
    );
    return {
      environments: results.flatMap((result) =>
        result.environment === undefined ? [] : [result.environment],
      ),
      failures: results.flatMap((result) => (result.failure === undefined ? [] : [result.failure])),
    };
  }

  public installEnvironment(
    manifest: string,
    environment?: string,
    options: CondaOperationOptions = {},
  ): Promise<CommandResult> {
    const args = ['install', '--yes'];
    if (environment !== undefined) {
      args.push('-e', requireValue(environment, 'environment'));
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
    if (options.format !== undefined) {
      args.push('--format', options.format);
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
    if (specs.length === 0) {
      throw new TypeError('specs must contain at least one dependency');
    }
    const args = ['add', '--yes'];
    if (options.feature !== undefined) {
      args.push('--feature', requireValue(options.feature, 'feature'));
    }
    if (options.noInstall === true) {
      args.push('--no-install');
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

  private runTask(
    manifest: string,
    args: readonly string[],
    options: CondaOperationOptions,
  ): Promise<CommandResult> {
    const manifestPath = absoluteManifestPath(manifest);
    return this.runChecked(
      ['task', '--file', manifestPath, ...args],
      options,
      dirname(manifestPath),
    );
  }
}
