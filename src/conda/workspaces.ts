import { dirname, posix, resolve, win32 } from 'node:path';

import { CondaClient, type CondaClientOperationOptions, requireValue } from './conda';
import {
  parseWorkspaceEnvironmentInfo,
  parseWorkspaceEnvironments,
  parseWorkspaceInfo,
  parseWorkspacePackages,
  parseWorkspaceQuickstartResult,
  parseWorkspaceSnapshot,
  parseWorkspaceTasks,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentInfo,
  type WorkspaceInfo,
  type WorkspaceDependency,
  type WorkspacePackage,
  type WorkspaceQuickstartResult,
  type WorkspaceSnapshotEnvironment,
  type WorkspaceSnapshotResolution,
  type WorkspaceTaskList,
} from './parsers';
import { type CommandResult } from './runner';

export type {
  WorkspaceDependency,
  WorkspaceDependencyLocation,
  WorkspaceEnvironment,
  WorkspaceEnvironmentInfo,
  WorkspaceInfo,
  WorkspacePackage,
  WorkspaceQuickstartResult,
  WorkspaceTask,
  WorkspaceTaskList,
} from './parsers';
export type CondaOperationOptions = CondaClientOperationOptions;

export type WorkspaceManifestFormat = 'conda' | 'pixi' | 'pyproject';

export interface QuickstartOptions extends CondaOperationOptions {
  readonly specs?: readonly string[];
  readonly format?: WorkspaceManifestFormat;
}

export interface DependencyChangeOptions extends CondaOperationOptions {
  readonly environment?: string;
  readonly feature?: string;
  readonly platform?: string;
  readonly pypi?: boolean;
  readonly noInstall?: boolean;
}

export interface WorkspaceEnvironmentDeclaration extends WorkspaceEnvironment {
  readonly condaDependencies?: readonly string[];
}

export interface WorkspacePython {
  readonly version: string;
  readonly executable: string;
}

export interface InstalledWorkspaceEnvironment {
  readonly name: string;
  readonly prefix: string;
  readonly features: readonly string[];
  readonly python: WorkspacePython | null;
  readonly packages: readonly WorkspacePackage[];
  readonly directDependencies: readonly WorkspaceDependency[];
}

export interface FailedWorkspaceEnvironmentDiscovery {
  readonly environmentName: string;
  readonly prefix?: string;
  readonly error: unknown;
}

export interface InstalledWorkspaceEnvironmentDiscovery {
  readonly declaredEnvironments: readonly WorkspaceEnvironmentDeclaration[];
  readonly environments: readonly InstalledWorkspaceEnvironment[];
  readonly failures: readonly FailedWorkspaceEnvironmentDiscovery[];
}

export interface CondaWorkspaceDiscovery extends InstalledWorkspaceEnvironmentDiscovery {
  readonly info: WorkspaceInfo;
  readonly snapshotAvailable: boolean;
}

function absoluteManifestPath(manifest: string): string {
  return resolve(requireValue(manifest, 'manifest'));
}

function pythonExecutable(prefix: string, condaPlatform: string): string {
  return condaPlatform.startsWith('win-')
    ? win32.join(prefix, 'python.exe')
    : posix.join(prefix, 'bin', 'python');
}

function snapshotOptionIsUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:unrecognized arguments|unknown option|no such option).*--packages/i.test(error.message)
  );
}

function hostSnapshotResolution(
  environment: WorkspaceSnapshotEnvironment,
  condaPlatform: string,
): WorkspaceSnapshotResolution | undefined {
  const exact = environment.resolutions.find((resolution) => resolution.platform === condaPlatform);
  if (exact !== undefined) {
    return exact;
  }
  for (const platform of environment.platforms) {
    const resolution = environment.resolutions.find((candidate) => candidate.platform === platform);
    if (resolution?.subdir === condaPlatform) {
      return resolution;
    }
  }
  return undefined;
}

function hostSnapshotEnvironment(
  environment: WorkspaceSnapshotEnvironment,
  condaPlatform: string,
): InstalledWorkspaceEnvironment {
  const resolution = hostSnapshotResolution(environment, condaPlatform);
  const directDependencies = resolution?.dependencies ?? [];
  const pythonPackage = environment.packages.find(
    (workspacePackage) => workspacePackage.name.toLowerCase() === 'python',
  );
  return {
    name: environment.name,
    prefix: environment.prefix,
    features: environment.features,
    python:
      pythonPackage === undefined
        ? null
        : {
            version: pythonPackage.version,
            executable: pythonExecutable(environment.prefix, condaPlatform),
          },
    packages: environment.packages,
    directDependencies,
  };
}

export class CondaWorkspacesClient extends CondaClient {
  private snapshotUnsupported = false;

  public resetCapabilityCache(): void {
    this.snapshotUnsupported = false;
  }

  public async discoverWorkspace(
    manifest: string,
    condaPlatform: string,
    options: CondaOperationOptions = {},
  ): Promise<CondaWorkspaceDiscovery> {
    if (!this.snapshotUnsupported) {
      try {
        const result = await this.runManifestCommand(
          'workspace',
          manifest,
          ['info', '--json', '--packages'],
          options,
        );
        const snapshot = parseWorkspaceSnapshot(result.stdout);
        const details = snapshot.environments.map((environment) => ({
          source: environment,
          environment: hostSnapshotEnvironment(environment, condaPlatform),
          resolution: hostSnapshotResolution(environment, condaPlatform),
        }));
        return {
          info: { manifest: snapshot.manifest, name: snapshot.name },
          environments: details
            .filter(({ source }) => source.installed)
            .map(({ environment }) => environment),
          declaredEnvironments: details.map(({ source, resolution }) => ({
            name: source.name,
            features: source.features,
            installed: source.installed,
            ...(resolution === undefined
              ? {}
              : {
                  condaDependencies: resolution.dependencies
                    .filter(({ pypi }) => !pypi)
                    .map(({ name }) => name),
                }),
          })),
          failures: [],
          snapshotAvailable: true,
        };
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw error;
        }
        this.snapshotUnsupported = snapshotOptionIsUnsupported(error);
      }
    }

    const info = await this.getWorkspaceInfo(manifest, options);
    const discovery = await this.discoverInstalledEnvironments(
      info.manifest,
      condaPlatform,
      options,
    );
    return { info, ...discovery, snapshotAvailable: false };
  }

  public async listTasks(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceTaskList> {
    const result = await this.runManifestCommand('task', manifest, ['list', '--json'], options);
    return parseWorkspaceTasks(result.stdout);
  }

  public async getWorkspaceInfo(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceInfo> {
    const result = await this.runManifestCommand(
      'workspace',
      manifest,
      ['info', '--json'],
      options,
    );
    return parseWorkspaceInfo(result.stdout);
  }

  public async listEnvironments(
    manifest: string,
    options: CondaOperationOptions = {},
  ): Promise<readonly WorkspaceEnvironment[]> {
    const result = await this.runManifestCommand(
      'workspace',
      manifest,
      ['envs', '--json'],
      options,
    );
    return parseWorkspaceEnvironments(result.stdout);
  }

  public async getEnvironmentInfo(
    manifest: string,
    environment: string,
    options: CondaOperationOptions = {},
  ): Promise<WorkspaceEnvironmentInfo> {
    const result = await this.runManifestCommand(
      'workspace',
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
    const result = await this.runManifestCommand(
      'workspace',
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
    const declaredEnvironments = await this.listEnvironments(manifest, options);
    const environments = declaredEnvironments.filter((environment) => environment.installed);
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
            name: info.name,
            prefix: info.prefix,
            features: environment.features,
            python:
              pythonPackage === undefined
                ? null
                : {
                    version: pythonPackage.version,
                    executable: pythonExecutable(info.prefix, platform),
                  },
            packages: packagesResult.value,
            directDependencies: [
              ...Object.keys(info.condaDependencies).map((name) => ({ name, pypi: false })),
              ...info.pypiDependencies.map((name) => ({ name, pypi: true })),
            ],
          },
        };
      }),
    );
    return {
      declaredEnvironments,
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
    const args = ['install', '--yes', '--json'];
    if (environment !== undefined) {
      args.push('-e', requireValue(environment, 'environment'));
    }
    return this.runManifestCommand('workspace', manifest, args, options);
  }

  public cleanEnvironment(
    manifest: string,
    environment?: string,
    options: CondaOperationOptions = {},
  ): Promise<CommandResult> {
    const args = ['clean', '--yes', '--json'];
    if (environment !== undefined) {
      args.push('-e', requireValue(environment, 'environment'));
    }
    return this.runManifestCommand('workspace', manifest, args, options);
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
    return this.changeDependencies('add', manifest, specs, options);
  }

  public removeDependencies(
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions = {},
  ): Promise<CommandResult> {
    return this.changeDependencies('remove', manifest, specs, options);
  }

  public updateDependencies(
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions = {},
  ): Promise<CommandResult> {
    if (options.pypi === true) {
      throw new TypeError('workspace update does not support PyPI dependencies');
    }
    return this.changeDependencies('update', manifest, specs, options);
  }

  private changeDependencies(
    operation: 'add' | 'remove' | 'update',
    manifest: string,
    specs: readonly string[],
    options: DependencyChangeOptions,
  ): Promise<CommandResult> {
    if (specs.length === 0) {
      throw new TypeError('specs must contain at least one dependency');
    }
    if (options.feature !== undefined && options.environment !== undefined) {
      throw new TypeError('feature and environment are mutually exclusive');
    }
    const args = [operation, '--yes', '--json'];
    if (options.pypi === true) {
      args.push('--pypi');
    }
    if (options.environment !== undefined) {
      args.push('--environment', requireValue(options.environment, 'environment'));
    }
    if (options.feature !== undefined) {
      args.push('--feature', requireValue(options.feature, 'feature'));
    }
    if (options.platform !== undefined) {
      args.push('--platform', requireValue(options.platform, 'platform'));
    }
    if (options.noInstall === true) {
      args.push('--no-install');
    }
    args.push('--', ...specs);
    return this.runManifestCommand('workspace', manifest, args, options);
  }

  private runManifestCommand(
    group: 'workspace' | 'task',
    manifest: string,
    args: readonly string[],
    options: CondaOperationOptions,
  ): Promise<CommandResult> {
    const manifestPath = absoluteManifestPath(manifest);
    return this.runChecked(
      [group, '--file', manifestPath, ...args],
      options,
      dirname(manifestPath),
    );
  }
}
