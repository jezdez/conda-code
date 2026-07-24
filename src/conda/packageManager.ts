import {
  DidChangePackagesEventArgs,
  Package,
  PackageManagementOptions,
  PackageManager,
  PythonEnvironment,
  PythonEnvironmentApi,
} from '@vscode/python-environments';
import { Disposable, EventEmitter, LogOutputChannel, ThemeIcon } from 'vscode';

import { diffPackages } from './changes';
import { CondaWorkspaceRouteManager, dependencyFeature } from './workspaceRouting';
import { CondaWorkspacesClient, WorkspacePackage } from './workspaces';

export interface CondaWorkspacePackageManagerOptions {
  readonly log?: LogOutputChannel;
}

interface PackageWithTransitiveState extends Package {
  readonly isTransitive?: boolean;
}

export class WorkspacePackageRemovalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspacePackageRemovalError';
  }
}

function normalizedPackageName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export class CondaWorkspacePackageManager implements PackageManager, Disposable {
  public readonly name = 'conda-workspaces';
  public readonly displayName = 'Conda Workspaces';
  public readonly description = 'Packages declared by conda workspace manifests and lockfiles';
  public readonly iconPath = new ThemeIcon('package');
  public readonly log?: LogOutputChannel;

  private readonly packagesByEnvironment = new Map<string, readonly Package[]>();
  private readonly onDidChangePackagesEmitter = new EventEmitter<DidChangePackagesEventArgs>();

  public readonly onDidChangePackages = this.onDidChangePackagesEmitter.event;

  public constructor(
    private readonly api: PythonEnvironmentApi,
    private readonly client: CondaWorkspacesClient,
    private readonly routes: CondaWorkspaceRouteManager,
    options: CondaWorkspacePackageManagerOptions = {},
  ) {
    this.log = options.log;
  }

  public async manage(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
  ): Promise<void> {
    const route = this.routes.getRoute(environment);
    if (route === undefined) {
      return;
    }

    const uninstall = options.uninstall?.filter((spec) => spec.trim() !== '') ?? [];
    const install = options.install?.filter((spec) => spec.trim() !== '') ?? [];
    if (uninstall.length === 0 && install.length === 0) {
      return;
    }
    if (uninstall.length > 0) {
      if (route.features.length > 0) {
        throw new WorkspacePackageRemovalError(
          `Package removal for feature-based environment ${route.environmentName} ` +
            `requires editing the manifest directly.`,
        );
      }
      const directDependencies = new Set(route.directCondaDependencies.map(normalizedPackageName));
      const transitive = uninstall.filter(
        (name) => !directDependencies.has(normalizedPackageName(name)),
      );
      if (transitive.length > 0) {
        throw new WorkspacePackageRemovalError(
          `Only direct manifest dependencies can be removed. These packages ` +
            `are transitive: ${transitive.join(', ')}`,
        );
      }
      await this.client.removeDependencies(route.manifestUri.fsPath, uninstall, {
        feature: undefined,
      });
    }
    if (install.length > 0) {
      const feature = dependencyFeature(route.environmentName, route.features);
      await this.client.addDependencies(route.manifestUri.fsPath, install, {
        feature,
      });
    }

    await this.routes.refresh(route.projectUri);
    this.packagesByEnvironment.delete(environment.envId.id);
    const refreshedEnvironment = this.routes.getEnvironmentForRoute(route);
    if (refreshedEnvironment !== undefined) {
      await this.refresh(refreshedEnvironment);
    }
  }

  public async refresh(environment: PythonEnvironment): Promise<void> {
    const route = this.routes.getRoute(environment);
    const key = environment.envId.id;
    if (route === undefined) {
      this.packagesByEnvironment.delete(key);
      return;
    }

    const previous = this.packagesByEnvironment.get(key) ?? [];
    const workspacePackages = await this.client.listPackages(
      route.manifestUri.fsPath,
      route.environmentName,
    );
    const current = this.toPackages(
      workspacePackages,
      environment,
      previous,
      route.directCondaDependencies,
    );
    this.packagesByEnvironment.set(key, current);

    const changes = diffPackages(previous, current);
    if (changes.length > 0) {
      this.onDidChangePackagesEmitter.fire({
        environment,
        manager: this,
        changes,
      });
    }
  }

  public async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
    const route = this.routes.getRoute(environment);
    if (route === undefined) {
      return undefined;
    }

    const key = environment.envId.id;
    const cached = this.packagesByEnvironment.get(key);
    if (cached !== undefined) {
      return [...cached];
    }

    const workspacePackages = await this.client.listPackages(
      route.manifestUri.fsPath,
      route.environmentName,
    );
    const packages = this.toPackages(
      workspacePackages,
      environment,
      [],
      route.directCondaDependencies,
    );
    this.packagesByEnvironment.set(key, packages);
    return packages;
  }

  public async clearCache(): Promise<void> {
    this.packagesByEnvironment.clear();
  }

  public dispose(): void {
    this.onDidChangePackagesEmitter.dispose();
    this.packagesByEnvironment.clear();
  }

  private toPackages(
    workspacePackages: readonly WorkspacePackage[],
    environment: PythonEnvironment,
    previous: readonly Package[],
    directDependencies: readonly string[],
  ): Package[] {
    const previousByName = new Map(previous.map((pkg) => [pkg.name, pkg]));
    const directNames = new Set(directDependencies.map(normalizedPackageName));
    return workspacePackages.map((pkg) => {
      const description = pkg.build === '' ? undefined : `Build ${pkg.build}`;
      const isTransitive = !directNames.has(normalizedPackageName(pkg.name));
      const cached = previousByName.get(pkg.name);
      if (
        cached?.version === pkg.version &&
        cached.description === description &&
        (cached as PackageWithTransitiveState).isTransitive === isTransitive
      ) {
        return cached;
      }
      const info = {
        name: pkg.name,
        displayName: pkg.name,
        version: pkg.version,
        description,
        isTransitive,
      };
      return this.api.createPackageItem(info, environment, this);
    });
  }
}
