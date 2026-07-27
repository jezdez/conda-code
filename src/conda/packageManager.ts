import {
  DidChangePackagesEventArgs,
  Package,
  PackageInfo,
  PackageManagementOptions,
  PackageManager,
  PythonEnvironment,
  PythonEnvironmentApi,
} from '@vscode/python-environments';
import {
  Disposable,
  EventEmitter,
  LogOutputChannel,
  ProgressLocation,
  ThemeIcon,
  window,
} from 'vscode';

import { diffPackages } from './changes';
import { CondaClient, CondaPackageRecord } from './conda';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteManager,
  dependencyFeature,
} from './workspaceRouting';
import {
  CondaWorkspacesClient,
  WorkspaceDependency,
  WorkspaceDependencyLocation,
  WorkspacePackage,
} from './workspaces';

export interface CondaPackageManagerOptions {
  readonly log?: LogOutputChannel;
}

interface GetPackagesOptions {
  readonly skipCache?: boolean;
}

function normalizedPackageName(value: string): string {
  return value.trim().toLowerCase();
}

function packageNameFromSpec(value: string): string {
  const unqualified = value.trim().split('::').at(-1) ?? '';
  return normalizedPackageName(unqualified.match(/^[A-Za-z0-9._-]+/)?.[0] ?? unqualified);
}

interface WorkspaceMutationGroup {
  readonly location: WorkspaceDependencyLocation;
  readonly pypi: boolean;
  readonly specs: string[];
}

export class CondaPackageManager implements PackageManager, Disposable {
  public readonly name = 'conda';
  public readonly displayName = 'Conda Code';
  public readonly description =
    'Packages installed in regular conda environments and workspace environments';
  public readonly iconPath = new ThemeIcon('package');
  public readonly log?: LogOutputChannel;

  private readonly packagesByEnvironment = new Map<string, readonly Package[]>();
  private readonly cachedEnvironments = new Map<string, PythonEnvironment>();
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
    let install = options.install?.filter((spec) => spec.trim() !== '') ?? [];
    const current = this.requireOwnedEnvironment(environment);
    if (uninstall.length === 0 && install.length === 0) {
      const spec = await window.showInputBox({
        title: `Manage a package in ${current.displayName}`,
        prompt: 'Enter one conda package specification to install or update',
        placeHolder: 'numpy>=2 or conda-forge::numpy >=2,<3',
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() === '' ? 'Enter a conda package specification' : undefined,
      });
      const trimmedSpec = spec?.trim();
      if (trimmedSpec === undefined || trimmedSpec === '') {
        return;
      }
      install = [trimmedSpec];
    }

    let route = this.routes.getRoute(current);
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Updating packages in ${current.displayName}`,
      },
      async () => {
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
          await this.routes.refresh(route.projectUri);
          const refreshedRoute = this.routes.getRoute(current);
          if (refreshedRoute === undefined) {
            throw new Error(`Workspace ownership changed for ${current.environmentPath.fsPath}`);
          }
          route = refreshedRoute;
          await this.manageWorkspace(route, uninstall, install, options.upgrade === true);
        }

        if (route === undefined) {
          this.routes.invalidateRegularDiscovery();
        }
        try {
          await this.routes.refresh(route?.projectUri ?? current.environmentPath);
          const refreshedEnvironment =
            route === undefined
              ? this.routes.getEnvironmentForPrefix(current.environmentPath.fsPath)
              : this.routes.getEnvironmentForRoute(route);
          if (refreshedEnvironment !== undefined) {
            if (refreshedEnvironment.envId.id !== current.envId.id) {
              this.packagesByEnvironment.delete(current.envId.id);
            }
            await this.refreshPackages(refreshedEnvironment, false);
          }
        } catch (error) {
          this.packagesByEnvironment.clear();
          this.cachedEnvironments.clear();
          throw error;
        }
      },
    );
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
      return this.loadAndCachePackages(currentEnvironment, true);
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
    this.cachedEnvironments.clear();
  }

  public resetWorkspaceCapabilities(): void {
    this.workspaces.resetCapabilityCache();
  }

  public async refreshCachedPackages(): Promise<void> {
    for (const [key, environment] of [...this.cachedEnvironments]) {
      const current = this.routes.getEnvironmentForPrefix(environment.environmentPath.fsPath);
      if (current === undefined) {
        this.packagesByEnvironment.delete(key);
        this.cachedEnvironments.delete(key);
        continue;
      }
      if (current.envId.id !== key) {
        const previous = this.packagesByEnvironment.get(key);
        if (previous !== undefined) {
          this.packagesByEnvironment.set(current.envId.id, previous);
        }
        this.packagesByEnvironment.delete(key);
        this.cachedEnvironments.delete(key);
      }
      await this.refreshPackages(current, false);
    }
  }

  public dispose(): void {
    this.onDidChangePackagesEmitter.dispose();
    this.packagesByEnvironment.clear();
    this.cachedEnvironments.clear();
  }

  private requireOwnedEnvironment(environment: PythonEnvironment): PythonEnvironment {
    const prefix = environment.environmentPath.fsPath;
    if (this.routes.isConflictedPrefix(prefix)) {
      throw new Error(`Multiple workspace manifests claim the prefix ${prefix}`);
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

  private async refreshPackages(
    environment: PythonEnvironment,
    refreshWorkspaceRoute = true,
  ): Promise<Package[]> {
    const previous = this.packagesByEnvironment.get(environment.envId.id) ?? [];
    const current = await this.loadAndCachePackages(environment, refreshWorkspaceRoute);

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

  private async loadAndCachePackages(
    environment: PythonEnvironment,
    refreshWorkspaceRoute = false,
  ): Promise<Package[]> {
    const route = this.routes.getRoute(environment);
    if (refreshWorkspaceRoute && route !== undefined) {
      await this.routes.refresh(route.projectUri);
    }
    const key = environment.envId.id;
    const previous = this.packagesByEnvironment.get(key) ?? [];
    const current = await this.loadPackages(environment, previous);
    this.packagesByEnvironment.set(key, current);
    this.cachedEnvironments.set(key, environment);
    return [...current];
  }

  private async manageWorkspace(
    route: CondaWorkspaceRoute,
    uninstall: readonly string[],
    install: readonly string[],
    upgrade: boolean,
  ): Promise<void> {
    const removals = this.workspaceMutationGroups(route, uninstall, false);
    const updates: string[] = [];
    const additions: string[] = [];
    for (const spec of install) {
      const dependency = this.workspaceDependency(route, spec);
      if (dependency !== undefined) {
        if (dependency.pypi) {
          throw new Error('Workspace update does not support PyPI dependencies');
        }
        updates.push(spec);
        continue;
      }
      if (upgrade || this.workspacePackageExists(route, spec)) {
        throw new Error(`Only direct workspace dependencies can be updated: ${spec}`);
      }
      additions.push(spec);
    }

    const updateGroups = this.workspaceMutationGroups(route, updates, true);
    const action =
      removals.length === 0 ? 'Update' : updateGroups.length === 0 ? 'Remove' : 'Change';
    if (!(await this.confirmSharedMutation([...removals, ...updateGroups], action))) {
      return;
    }

    try {
      for (const group of removals) {
        await this.workspaces.removeDependencies(route.manifestUri.fsPath, group.specs, {
          ...group.location,
          pypi: group.pypi,
        });
      }
      for (const group of updateGroups) {
        await this.workspaces.updateDependencies(route.manifestUri.fsPath, group.specs, {
          ...group.location,
        });
      }
      if (additions.length > 0) {
        const target = route.snapshotAvailable
          ? { environment: route.environmentName }
          : { feature: dependencyFeature(route.environmentName, route.features) };
        await this.workspaces.addDependencies(route.manifestUri.fsPath, additions, target);
      }
    } catch (error) {
      try {
        await this.routes.refresh(route.projectUri);
      } catch (refreshError) {
        this.log?.warn(
          `Could not refresh after a workspace package error: ${String(refreshError)}`,
        );
      }
      this.packagesByEnvironment.clear();
      this.cachedEnvironments.clear();
      throw error;
    }
  }

  private workspaceDependency(
    route: CondaWorkspaceRoute,
    spec: string,
  ): WorkspaceDependency | undefined {
    const name = packageNameFromSpec(spec);
    return route.directDependencies.find(
      (dependency) => normalizedPackageName(dependency.name) === name,
    );
  }

  private workspacePackageExists(route: CondaWorkspaceRoute, spec: string): boolean {
    const name = packageNameFromSpec(spec);
    return route.packages.some((pkg) => normalizedPackageName(pkg.name) === name);
  }

  private workspaceMutationGroups(
    route: CondaWorkspaceRoute,
    specs: readonly string[],
    preserveSpecs: boolean,
  ): WorkspaceMutationGroup[] {
    const groups = new Map<string, WorkspaceMutationGroup>();
    for (const spec of specs) {
      const dependency = this.workspaceDependency(route, spec);
      if (dependency === undefined) {
        throw new Error(`Only direct workspace dependencies can be changed: ${spec}`);
      }
      if (dependency.location === undefined) {
        throw new Error(
          `Workspace dependency changes require a structured declaration location. ` +
            `Edit ${route.manifestUri.fsPath} directly, then refresh Conda Code.`,
        );
      }

      const key = JSON.stringify([dependency.pypi, dependency.location]);
      const group = groups.get(key);
      const value = preserveSpecs ? spec : dependency.name;
      if (group === undefined) {
        groups.set(key, {
          location: dependency.location,
          pypi: dependency.pypi,
          specs: [value],
        });
      } else {
        group.specs.push(value);
      }
    }
    return [...groups.values()];
  }

  private async confirmSharedMutation(
    groups: readonly WorkspaceMutationGroup[],
    action: 'Change' | 'Remove' | 'Update',
  ): Promise<boolean> {
    if (groups.every(({ location }) => location.environment !== undefined)) {
      return true;
    }
    const choice = await window.showWarningMessage(
      `${action} shared workspace dependencies? This may change other environments.`,
      { modal: true },
      action,
    );
    return choice === action;
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
        : this.workspacePackageInfo(route.packages, route.directDependencies);
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
    directDependencies: readonly WorkspaceDependency[],
  ): PackageInfo[] {
    const directByName = new Map(
      directDependencies.map((dependency) => [normalizedPackageName(dependency.name), dependency]),
    );
    return workspacePackages
      .map((pkg) => {
        const direct = directByName.get(normalizedPackageName(pkg.name));
        const isTransitive = direct === undefined;
        const details = [
          pkg.build === '' ? undefined : `Build ${pkg.build}`,
          isTransitive
            ? 'Transitive dependency'
            : direct.pypi
              ? 'Direct PyPI dependency'
              : 'Direct dependency',
        ].filter((value): value is string => value !== undefined);
        return {
          name: pkg.name,
          displayName: pkg.name,
          version: pkg.version,
          description: details.join(', '),
          ...(direct?.table === undefined ? {} : { tooltip: `Declared in ${direct.table}` }),
          isTransitive,
        };
      })
      .sort((left, right) => {
        if (left.isTransitive !== right.isTransitive) {
          return left.isTransitive ? 1 : -1;
        }
        return left.name.localeCompare(right.name);
      });
  }
}
