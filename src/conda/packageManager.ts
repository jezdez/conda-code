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
  CondaWorkspaceRouteManager,
  dependencyFeature,
} from './workspaceRouting';
import { CondaWorkspacesClient, WorkspacePackage } from './workspaces';

export interface CondaPackageManagerOptions {
  readonly log?: LogOutputChannel;
}

interface GetPackagesOptions {
  readonly skipCache?: boolean;
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
      const conda = this.condaForPrefix(current.environmentPath.fsPath, true);
      if (uninstall.length > 0) {
        await conda.removePackages(current.environmentPath.fsPath, uninstall);
      }
      if (install.length > 0) {
        await conda.installPackages(current.environmentPath.fsPath, install, {
          upgrade: options.upgrade,
        });
      }
    } else {
      if (options.upgrade === true && install.length > 0) {
        throw new Error(
          `Conda workspace package upgrades are not supported. ` +
            `Edit ${route.manifestUri.fsPath} directly, then refresh Conda Code.`,
        );
      }
      await this.manageWorkspace(route, uninstall, install);
    }

    if (route === undefined) {
      this.routes.invalidateRegularDiscovery();
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

  // Python Environments 1.36 renders this returned list, while its published
  // 1.0 API types still declare Promise<void>. Keep both signatures until the
  // API package catches up with the extension runtime.
  public refresh(environment: PythonEnvironment): Promise<Package[]>;
  public refresh(environment: PythonEnvironment): Promise<void>;
  public async refresh(environment: PythonEnvironment): Promise<Package[] | void> {
    const currentEnvironment = this.requireOwnedEnvironment(environment);
    return this.refreshPackages(currentEnvironment);
  }

  public async getPackages(
    environment: PythonEnvironment,
    options: GetPackagesOptions = {},
  ): Promise<Package[] | undefined> {
    const currentEnvironment = this.currentEnvironment(environment);
    if (currentEnvironment === undefined) {
      return undefined;
    }

    if (options.skipCache === true) {
      return this.loadAndCachePackages(currentEnvironment);
    }

    const key = currentEnvironment.envId.id;
    const cached = this.packagesByEnvironment.get(key);
    if (cached !== undefined) {
      return [...cached];
    }

    return this.loadAndCachePackages(currentEnvironment);
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
      throw new Error(`Multiple conda workspace manifests claim the prefix ${prefix}`);
    }
    const current = this.currentEnvironment(environment);
    if (current === undefined) {
      throw new Error(`Conda Code does not own the environment prefix ${prefix}`);
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

  private async refreshPackages(environment: PythonEnvironment): Promise<Package[]> {
    const previous = this.packagesByEnvironment.get(environment.envId.id) ?? [];
    const current = await this.loadAndCachePackages(environment);

    const changes = diffPackages(previous, current);
    if (changes.length > 0) {
      this.onDidChangePackagesEmitter.fire({
        environment,
        manager: this,
        changes,
      });
    }
    return current;
  }

  private async loadAndCachePackages(environment: PythonEnvironment): Promise<Package[]> {
    const key = environment.envId.id;
    const previous = this.packagesByEnvironment.get(key) ?? [];
    const current = await this.loadPackages(environment, previous);
    this.packagesByEnvironment.set(key, current);
    return [...current];
  }

  private async manageWorkspace(
    route: CondaWorkspaceRoute,
    uninstall: readonly string[],
    install: readonly string[],
  ): Promise<void> {
    if (uninstall.length > 0) {
      throw new Error(
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
            await this.condaForPrefix(environment.environmentPath.fsPath, false).listPrefixPackages(
              environment.environmentPath.fsPath,
            ),
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

  private condaForPrefix(prefix: string, requireOwner: boolean): CondaClient {
    const executable = this.routes.getCondaExecutableForPrefix(prefix);
    if (executable === undefined) {
      if (requireOwner) {
        throw new Error(`Conda Code does not know which conda installation owns ${prefix}`);
      }
      return this.conda;
    }
    return this.conda.forExecutable(executable);
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
