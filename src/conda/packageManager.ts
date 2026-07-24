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
import { CondaClient, CondaPackageRecord } from './conda';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteConflictError,
  CondaWorkspaceRouteManager,
  dependencyFeature,
} from './workspaceRouting';
import { CondaWorkspacesClient, WorkspacePackage } from './workspaces';

export interface CondaPackageManagerOptions {
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

export class CondaEnvironmentOwnershipError extends Error {
  public constructor(prefix: string) {
    super(`Conda Code does not own the environment prefix ${prefix}`);
    this.name = 'CondaEnvironmentOwnershipError';
  }
}

function normalizedPackageName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export class CondaPackageManager implements PackageManager, Disposable {
  public readonly name = 'conda';
  public readonly displayName = 'Conda Code';
  public readonly description = 'Packages installed in conda and conda workspace environments';
  public readonly iconPath = new ThemeIcon('package');
  public readonly log?: LogOutputChannel;

  private readonly packagesByEnvironment = new Map<string, readonly Package[]>();
  private readonly onDidChangePackagesEmitter = new EventEmitter<DidChangePackagesEventArgs>();

  public readonly onDidChangePackages = this.onDidChangePackagesEmitter.event;

  public constructor(
    private readonly api: PythonEnvironmentApi,
    private readonly conda: CondaClient,
    private readonly workspaces: CondaWorkspacesClient,
    private readonly routes: CondaWorkspaceRouteManager,
    options: CondaPackageManagerOptions = {},
  ) {
    this.log = options.log;
  }

  public async manage(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
  ): Promise<void> {
    const uninstall = options.uninstall?.filter((spec) => spec.trim() !== '') ?? [];
    const install = options.install?.filter((spec) => spec.trim() !== '') ?? [];
    if (uninstall.length === 0 && install.length === 0) {
      return;
    }

    const current = this.requireOwnedEnvironment(environment);
    const route = this.routes.getRoute(current);
    if (route === undefined) {
      if (uninstall.length > 0) {
        await this.conda.removePackages(current.environmentPath.fsPath, uninstall);
      }
      if (install.length > 0) {
        await this.conda.installPackages(current.environmentPath.fsPath, install, {
          upgrade: options.upgrade,
        });
      }
    } else {
      await this.manageWorkspace(route, uninstall, install);
    }

    await this.routes.refresh(route?.projectUri ?? current.environmentPath);
    this.packagesByEnvironment.delete(current.envId.id);
    const refreshedEnvironment =
      route === undefined
        ? this.routes.getEnvironmentForPrefix(current.environmentPath.fsPath)
        : this.routes.getEnvironmentForRoute(route);
    if (refreshedEnvironment !== undefined) {
      await this.refresh(refreshedEnvironment);
    }
  }

  public async refresh(environment: PythonEnvironment): Promise<void> {
    const currentEnvironment = this.requireOwnedEnvironment(environment);
    const key = currentEnvironment.envId.id;
    const previous = this.packagesByEnvironment.get(key) ?? [];
    const route = this.routes.getRoute(currentEnvironment);
    const current =
      route === undefined
        ? this.toCondaPackages(
            await this.conda.listPackages(currentEnvironment.environmentPath.fsPath),
            currentEnvironment,
            previous,
          )
        : this.toWorkspacePackages(
            await this.workspaces.listPackages(route.manifestUri.fsPath, route.environmentName),
            currentEnvironment,
            previous,
            route.directCondaDependencies,
          );
    this.packagesByEnvironment.set(key, current);

    const changes = diffPackages(previous, current);
    if (changes.length > 0) {
      this.onDidChangePackagesEmitter.fire({
        environment: currentEnvironment,
        manager: this,
        changes,
      });
    }
  }

  public async getPackages(environment: PythonEnvironment): Promise<Package[] | undefined> {
    const currentEnvironment = this.routes.getEnvironmentForPrefix(
      environment.environmentPath.fsPath,
    );
    if (
      currentEnvironment === undefined ||
      currentEnvironment.envId.id !== environment.envId.id ||
      currentEnvironment.envId.managerId !== environment.envId.managerId ||
      currentEnvironment.description !== environment.description ||
      currentEnvironment.tooltip !== environment.tooltip
    ) {
      return undefined;
    }

    const key = currentEnvironment.envId.id;
    const cached = this.packagesByEnvironment.get(key);
    if (cached !== undefined) {
      return [...cached];
    }

    const route = this.routes.getRoute(currentEnvironment);
    const packages =
      route === undefined
        ? this.toCondaPackages(
            await this.conda.listPackages(currentEnvironment.environmentPath.fsPath),
            currentEnvironment,
            [],
          )
        : this.toWorkspacePackages(
            await this.workspaces.listPackages(route.manifestUri.fsPath, route.environmentName),
            currentEnvironment,
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

  private requireOwnedEnvironment(environment: PythonEnvironment): PythonEnvironment {
    const prefix = environment.environmentPath.fsPath;
    if (this.routes.isConflictedPrefix(prefix)) {
      throw new CondaWorkspaceRouteConflictError(prefix);
    }
    const current = this.routes.getEnvironmentForPrefix(prefix);
    if (
      current === undefined ||
      current.envId.id !== environment.envId.id ||
      current.envId.managerId !== environment.envId.managerId ||
      current.description !== environment.description ||
      current.tooltip !== environment.tooltip
    ) {
      throw new CondaEnvironmentOwnershipError(prefix);
    }
    return current;
  }

  private async manageWorkspace(
    route: CondaWorkspaceRoute,
    uninstall: readonly string[],
    install: readonly string[],
  ): Promise<void> {
    if (uninstall.length > 0) {
      if (route.features.length > 0) {
        throw new WorkspacePackageRemovalError(
          `Package removal for feature-based environment ${route.environmentName} ` +
            'requires editing the manifest directly.',
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
      await this.workspaces.removeDependencies(route.manifestUri.fsPath, uninstall, {
        feature: undefined,
      });
    }
    if (install.length > 0) {
      const feature = dependencyFeature(route.environmentName, route.features);
      await this.workspaces.addDependencies(route.manifestUri.fsPath, install, {
        feature,
      });
    }
  }

  private toCondaPackages(
    condaPackages: readonly CondaPackageRecord[],
    environment: PythonEnvironment,
    previous: readonly Package[],
  ): Package[] {
    const previousByName = new Map(previous.map((pkg) => [pkg.name, pkg]));
    return condaPackages.map((pkg) => {
      const descriptionParts = [
        pkg.build === '' ? undefined : `Build ${pkg.build}`,
        pkg.channel === undefined ? undefined : `Channel ${pkg.channel}`,
      ].filter((value): value is string => value !== undefined);
      const description = descriptionParts.length === 0 ? undefined : descriptionParts.join(', ');
      const cached = previousByName.get(pkg.name);
      if (cached?.version === pkg.version && cached.description === description) {
        return cached;
      }
      return this.api.createPackageItem(
        {
          name: pkg.name,
          displayName: pkg.name,
          version: pkg.version,
          description,
        },
        environment,
        this,
      );
    });
  }

  private toWorkspacePackages(
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
