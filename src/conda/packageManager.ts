import {
  DidChangePackagesEventArgs,
  Package,
  PackageInfo,
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

interface CachedPackages {
  readonly environment: PythonEnvironment;
  readonly packages: readonly Package[];
}

export class WorkspacePackageRemovalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspacePackageRemovalError';
  }
}

export class WorkspacePackageUpgradeError extends Error {
  public constructor(manifest: string) {
    super(
      `Conda workspace package upgrades are not supported. Edit ${manifest} directly, ` +
        'then refresh Conda Code.',
    );
    this.name = 'WorkspacePackageUpgradeError';
  }
}

export class CondaEnvironmentOwnershipError extends Error {
  public constructor(prefix: string) {
    super(`Conda Code does not own the environment prefix ${prefix}`);
    this.name = 'CondaEnvironmentOwnershipError';
  }
}

function normalizedPackageName(value: string): string {
  return value.trim().toLowerCase();
}

export class CondaPackageManager implements PackageManager, Disposable {
  public readonly name = 'conda';
  public readonly displayName = 'Conda Code';
  public readonly description = 'Packages installed in conda and conda workspace environments';
  public readonly iconPath = new ThemeIcon('package');
  public readonly log?: LogOutputChannel;

  private readonly packagesByEnvironment = new Map<string, CachedPackages>();
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
      if (options.upgrade === true && install.length > 0) {
        throw new WorkspacePackageUpgradeError(route.manifestUri.fsPath);
      }
      await this.manageWorkspace(route, uninstall, install);
    }

    await this.routes.refresh(route?.projectUri ?? current.environmentPath);
    const refreshedEnvironment =
      route === undefined
        ? this.routes.getEnvironmentForPrefix(current.environmentPath.fsPath)
        : this.routes.getEnvironmentForRoute(route);
    if (refreshedEnvironment !== undefined) {
      if (refreshedEnvironment.envId.id !== current.envId.id) {
        this.packagesByEnvironment.delete(current.envId.id);
      }
      await this.refresh(refreshedEnvironment);
    }
  }

  public async refresh(environment: PythonEnvironment): Promise<void> {
    const currentEnvironment = this.requireOwnedEnvironment(environment);
    const key = currentEnvironment.envId.id;
    const previous = this.packagesByEnvironment.get(key)?.packages ?? [];
    const current = await this.loadPackages(currentEnvironment, previous);
    this.packagesByEnvironment.set(key, {
      environment: currentEnvironment,
      packages: current,
    });

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
    const currentEnvironment = this.currentEnvironment(environment);
    if (currentEnvironment === undefined) {
      return undefined;
    }

    const key = currentEnvironment.envId.id;
    const cached = this.packagesByEnvironment.get(key);
    if (cached !== undefined) {
      return [...cached.packages];
    }

    const packages = await this.loadPackages(currentEnvironment, []);
    this.packagesByEnvironment.set(key, {
      environment: currentEnvironment,
      packages,
    });
    return packages;
  }

  public async clearCache(): Promise<void> {
    const cached = [...this.packagesByEnvironment.values()];
    this.packagesByEnvironment.clear();
    for (const { environment, packages } of cached) {
      const changes = diffPackages(packages, []);
      if (changes.length > 0) {
        this.onDidChangePackagesEmitter.fire({
          environment,
          manager: this,
          changes,
        });
      }
    }
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
    const current = this.currentEnvironment(environment);
    if (current === undefined) {
      throw new CondaEnvironmentOwnershipError(prefix);
    }
    return current;
  }

  private currentEnvironment(environment: PythonEnvironment): PythonEnvironment | undefined {
    const current = this.routes.getEnvironmentForPrefix(environment.environmentPath.fsPath);
    return current !== undefined &&
      current.envId.id === environment.envId.id &&
      current.envId.managerId === environment.envId.managerId
      ? current
      : undefined;
  }

  private async manageWorkspace(
    route: CondaWorkspaceRoute,
    uninstall: readonly string[],
    install: readonly string[],
  ): Promise<void> {
    if (uninstall.length > 0) {
      throw new WorkspacePackageRemovalError(
        `Conda workspace package removal is not supported. Edit ${route.manifestUri.fsPath} ` +
          'directly, then refresh Conda Code.',
      );
    }
    if (install.length > 0) {
      const feature = dependencyFeature(route.environmentName, route.features);
      await this.workspaces.addDependencies(route.manifestUri.fsPath, install, {
        feature,
      });
    }
  }

  private async loadPackages(
    environment: PythonEnvironment,
    previous: readonly Package[],
  ): Promise<Package[]> {
    const route = this.routes.getRoute(environment);
    const packageInfo =
      route === undefined
        ? this.condaPackageInfo(
            await this.conda.listPrefixPackages(environment.environmentPath.fsPath),
          )
        : this.workspacePackageInfo(
            await this.workspaces.listPackages(route.manifestUri.fsPath, route.environmentName),
            route.directCondaDependencies,
          );
    const previousByName = new Map(previous.map((pkg) => [pkg.name, pkg]));
    return packageInfo.map((info) => {
      const cached = previousByName.get(info.name);
      if (
        cached !== undefined &&
        cached.version === info.version &&
        cached.description === info.description &&
        cached.tooltip === info.tooltip
      ) {
        return cached;
      }
      return this.api.createPackageItem(info, environment, this);
    });
  }

  private condaPackageInfo(condaPackages: readonly CondaPackageRecord[]): PackageInfo[] {
    return condaPackages.map((pkg) => {
      const details = [
        pkg.build === '' ? undefined : `Build ${pkg.build}`,
        pkg.channel === undefined ? undefined : `Channel ${pkg.channel}`,
      ].filter((value): value is string => value !== undefined);
      return {
        name: pkg.name,
        displayName: pkg.name,
        version: pkg.version,
        ...(details.length === 0 ? {} : { description: details.join(', ') }),
      };
    });
  }

  private workspacePackageInfo(
    workspacePackages: readonly WorkspacePackage[],
    directDependencies: readonly string[],
  ): PackageInfo[] {
    const directNames = new Set(directDependencies.map(normalizedPackageName));
    return workspacePackages.map((pkg) => {
      const isTransitive = !directNames.has(normalizedPackageName(pkg.name));
      const details = [
        pkg.build === '' ? undefined : `Build ${pkg.build}`,
        isTransitive ? 'Transitive dependency' : 'Direct dependency',
      ].filter((value): value is string => value !== undefined);
      return {
        name: pkg.name,
        displayName: pkg.name,
        version: pkg.version,
        description: details.join(', '),
      };
    });
  }
}
