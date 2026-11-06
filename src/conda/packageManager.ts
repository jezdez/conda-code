import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { compare, explain } from '@renovatebot/pep440';
import {
  DidChangePackagesEventArgs,
  GetPackagesOptions,
  Package,
  PackageInfo,
  PackageManagementOptions,
  PackageManager,
  PackageVersionLookupNotSupportedError,
  Pep440Version,
  PythonEnvironment,
  PythonEnvironmentApi,
} from '@vscode/python-environments';
import {
  Disposable,
  EventEmitter,
  LogOutputChannel,
  ProgressLocation,
  RelativePattern,
  ThemeIcon,
  window,
} from 'vscode';

import { diffPackages } from './changes';
import { CondaClient, CondaPackageRecord } from './conda';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteManager,
  dependencyFeature,
  normalizeEnvironmentPath,
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
  private readonly pendingReads = new Map<string, object>();
  private cacheGeneration = 0;
  private disposed = false;
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
      if (options.runHeadless === true) {
        return;
      }
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
    let mutationsComplete = false;
    const execute = async () => {
      this.requireOwnedEnvironment(current);
      if (route === undefined) {
        const owner = this.routes.getCondaExecutableForPrefix(current.environmentPath.fsPath);
        const conda = this.condaForPrefix(current.environmentPath.fsPath, true);
        const requireTarget = () => {
          this.requireOwnedEnvironment(current);
          if (
            this.routes.getRoute(current) !== undefined ||
            this.routes.getCondaExecutableForPrefix(current.environmentPath.fsPath) !== owner
          ) {
            throw new Error('Conda ownership changed during package mutation');
          }
        };
        if (uninstall.length > 0) {
          requireTarget();
          await conda.removePackages(current.environmentPath.fsPath, uninstall);
        }
        if (install.length > 0) {
          requireTarget();
          await conda.installPackages(current.environmentPath.fsPath, install, {
            upgrade: options.upgrade,
          });
        }
      } else {
        await this.routes.refresh(route.projectUri);
        this.requireOwnedEnvironment(current);
        const refreshedRoute = this.routes.getRoute(current);
        if (refreshedRoute === undefined || !this.sameWorkspaceTarget(route, refreshedRoute)) {
          throw new Error(`Workspace ownership changed for ${current.environmentPath.fsPath}`);
        }
        route = refreshedRoute;
        await this.manageWorkspace(current, route, uninstall, install, options);
      }

      if (route === undefined) {
        this.routes.invalidateRegularDiscovery();
      }
      mutationsComplete = true;
      await this.routes.refresh(route?.projectUri ?? current.environmentPath);
      const refreshedEnvironment =
        route === undefined
          ? this.routes.getEnvironmentForPrefix(current.environmentPath.fsPath)
          : this.routes.getEnvironmentForRoute(route);
      if (refreshedEnvironment !== undefined) {
        if (refreshedEnvironment.envId.id !== current.envId.id) {
          this.packagesByEnvironment.delete(current.envId.id);
          this.cachedEnvironments.delete(current.envId.id);
          this.pendingReads.delete(current.envId.id);
        }
        await this.refreshPackages(refreshedEnvironment, false);
      }
    };
    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Updating packages in ${current.displayName}`,
        },
        execute,
      );
    } catch (error) {
      const previous = this.packagesByEnvironment.get(current.envId.id) ?? [];
      await this.clearCache();
      if (mutationsComplete) {
        throw error;
      }
      if (route === undefined) {
        this.routes.invalidateRegularDiscovery();
      }
      try {
        await this.routes.refresh(route?.projectUri ?? current.environmentPath);
        const refreshed = this.routes.getEnvironmentForPrefix(current.environmentPath.fsPath);
        if (refreshed !== undefined) {
          await this.refreshPackages(this.requireOwnedEnvironment(refreshed), false, previous);
        }
      } catch (refreshError) {
        this.log?.warn(`Could not refresh after a package error: ${String(refreshError)}`);
      }
      throw error;
    }
  }

  // Python Environments 1.36 renders this returned list, while its
  // published API types still declare Promise<void>. Keep both signatures until the
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
      return [...(await this.loadAndCachePackages(currentEnvironment, true))];
    }

    const key = currentEnvironment.envId.id;
    const cached = this.packagesByEnvironment.get(key);
    if (cached !== undefined) {
      return [...cached];
    }

    return [...(await this.loadAndCachePackages(currentEnvironment))];
  }

  public async clearCache(): Promise<void> {
    this.cacheGeneration++;
    this.packagesByEnvironment.clear();
    this.pendingReads.clear();
    this.cachedEnvironments.clear();
  }

  public formatInstallSpec(packageName: string, version: string): string {
    return `${packageName}==${version}`;
  }

  public async getVersion(environment: PythonEnvironment): Promise<Pep440Version | undefined> {
    const current = this.requireOwnedEnvironment(environment);
    const conda =
      this.routes.getRoute(current) === undefined
        ? this.condaForPrefix(current.environmentPath.fsPath, true)
        : this.conda;
    return explain(await conda.getVersion()) ?? undefined;
  }

  public async getPackageAvailableVersions(
    environment: PythonEnvironment,
    packageName: string,
  ): Promise<Pep440Version[]> {
    const current = this.requireOwnedEnvironment(environment);
    if (this.routes.getRoute(current) !== undefined) {
      throw new PackageVersionLookupNotSupportedError();
    }
    const versions = await this.condaForPrefix(
      current.environmentPath.fsPath,
      true,
    ).getPackageVersions(packageName);
    const parsed = new Map<string, Pep440Version>();
    for (const value of versions) {
      const version = explain(value);
      if (version === null) {
        throw new Error(`Conda package version cannot be represented by the Python API: ${value}`);
      }
      parsed.set(version.public + (version.local === null ? '' : `+${version.local}`), version);
    }
    return [...parsed.entries()]
      .sort(([left], [right]) => compare(right, left))
      .map(([, version]) => version);
  }

  public getPackageWatchTargets(environment: PythonEnvironment): RelativePattern[] {
    const current = this.currentEnvironment(environment);
    return current === undefined || this.routes.isConflictedPrefix(current.environmentPath.fsPath)
      ? []
      : [new RelativePattern(path.join(current.environmentPath.fsPath, 'conda-meta'), '*.json')];
  }

  public async getDirectPackageNames(
    environment: PythonEnvironment,
  ): Promise<Set<string> | undefined> {
    const current = this.currentEnvironment(environment);
    if (current === undefined || this.routes.isConflictedPrefix(current.environmentPath.fsPath)) {
      return undefined;
    }
    const route = this.routes.getRoute(current);
    return route === undefined
      ? undefined
      : new Set(route.directDependencies.map(({ name }) => normalizedPackageName(name)));
  }

  public resetWorkspaceCapabilities(): void {
    this.workspaces.resetCapabilityCache();
  }

  public async refreshCachedPackages(): Promise<void> {
    const generation = this.cacheGeneration;
    for (const [key, environment] of [...this.cachedEnvironments]) {
      if (this.disposed || this.cacheGeneration !== generation) {
        return;
      }
      const current = this.routes.getEnvironmentForPrefix(environment.environmentPath.fsPath);
      if (
        current === undefined ||
        current.envId.managerId !== environment.envId.managerId ||
        this.routes.isConflictedPrefix(environment.environmentPath.fsPath)
      ) {
        this.packagesByEnvironment.delete(key);
        this.cachedEnvironments.delete(key);
        this.pendingReads.delete(key);
        continue;
      }
      const previous = this.packagesByEnvironment.get(key) ?? [];
      if (current.envId.id !== key) {
        this.packagesByEnvironment.delete(key);
        this.cachedEnvironments.delete(key);
        this.pendingReads.delete(key);
      }
      await this.refreshPackages(current, false, previous);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.pendingReads.clear();
    this.onDidChangePackagesEmitter.dispose();
    this.packagesByEnvironment.clear();
    this.cachedEnvironments.clear();
  }

  private requireOwnedEnvironment(environment: PythonEnvironment): PythonEnvironment {
    if (this.disposed) {
      throw new Error('Package manager is disposed');
    }
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
    if (this.disposed || this.routes.isConflictedPrefix(environment.environmentPath.fsPath)) {
      return undefined;
    }
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
    previous = this.packagesByEnvironment.get(environment.envId.id) ?? [],
  ): Promise<Package[]> {
    const current = await this.loadAndCachePackages(environment, refreshWorkspaceRoute);

    if (this.disposed || this.packagesByEnvironment.get(environment.envId.id) !== current) {
      return [...current];
    }
    const changes = diffPackages(previous, current);
    if (changes.length > 0) {
      this.onDidChangePackagesEmitter.fire({
        environment,
        manager: this,
        changes,
      });
    }
    return [...current];
  }

  private async loadAndCachePackages(
    environment: PythonEnvironment,
    refreshWorkspaceRoute = false,
  ): Promise<Package[]> {
    this.requireOwnedEnvironment(environment);
    const key = environment.envId.id;
    const request = {};
    const generation = this.cacheGeneration;
    this.pendingReads.set(key, request);
    try {
      const route = this.routes.getRoute(environment);
      if (refreshWorkspaceRoute && route !== undefined) {
        await this.routes.refresh(route.projectUri);
      }
      this.requireOwnedEnvironment(environment);
      const refreshedRoute = this.routes.getRoute(environment);
      if (
        route !== undefined &&
        (refreshedRoute === undefined || !this.sameWorkspaceTarget(route, refreshedRoute))
      ) {
        throw new Error('Workspace ownership changed during package refresh');
      }
      if (this.cacheGeneration !== generation) {
        throw new Error('Package read was superseded');
      }
      const previous = this.packagesByEnvironment.get(key) ?? [];
      const current = await this.loadPackages(environment, previous);
      this.requireOwnedEnvironment(environment);
      if (this.cacheGeneration !== generation) {
        throw new Error('Package read was superseded');
      }
      if (this.pendingReads.get(key) === request) {
        this.packagesByEnvironment.set(key, current);
        this.cachedEnvironments.set(key, environment);
      }
      return current;
    } finally {
      if (this.pendingReads.get(key) === request) {
        this.pendingReads.delete(key);
      }
    }
  }

  private async manageWorkspace(
    environment: PythonEnvironment,
    route: CondaWorkspaceRoute,
    uninstall: readonly string[],
    install: readonly string[],
    options: PackageManagementOptions,
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
      if (options.upgrade === true || this.workspacePackageExists(route, spec)) {
        throw new Error(`Only direct workspace dependencies can be updated: ${spec}`);
      }
      additions.push(spec);
    }

    const updateGroups = this.workspaceMutationGroups(route, updates, true);
    const action =
      removals.length === 0 ? 'Update' : updateGroups.length === 0 ? 'Remove' : 'Change';
    if (
      !(await this.confirmSharedMutation(
        [...removals, ...updateGroups],
        action,
        options.runHeadless === true,
      ))
    ) {
      return;
    }

    this.requireOwnedEnvironment(environment);
    const confirmedRoute = this.routes.getRoute(environment);
    if (
      confirmedRoute === undefined ||
      !this.sameWorkspaceTarget(route, confirmedRoute) ||
      confirmedRoute.snapshotAvailable !== route.snapshotAvailable ||
      !isDeepStrictEqual(confirmedRoute.features, route.features) ||
      !isDeepStrictEqual(confirmedRoute.directDependencies, route.directDependencies)
    ) {
      throw new Error('Workspace ownership changed during package confirmation');
    }
    const target =
      additions.length === 0
        ? undefined
        : route.snapshotAvailable
          ? { environment: route.environmentName }
          : { feature: dependencyFeature(route.environmentName, route.features) };
    const requireTarget = () => {
      this.requireOwnedEnvironment(environment);
      const current = this.routes.getRoute(environment);
      if (current === undefined || !this.sameWorkspaceTarget(route, current)) {
        throw new Error('Workspace ownership changed during package mutation');
      }
    };
    for (const group of removals) {
      requireTarget();
      await this.workspaces.removeDependencies(route.manifestUri.fsPath, group.specs, {
        ...group.location,
        pypi: group.pypi,
      });
    }
    for (const group of updateGroups) {
      requireTarget();
      await this.workspaces.updateDependencies(route.manifestUri.fsPath, group.specs, {
        ...group.location,
      });
    }
    if (target !== undefined) {
      requireTarget();
      await this.workspaces.addDependencies(route.manifestUri.fsPath, additions, target);
    }
  }

  private sameWorkspaceTarget(left: CondaWorkspaceRoute, right: CondaWorkspaceRoute): boolean {
    return (
      normalizeEnvironmentPath(left.projectUri.fsPath) ===
        normalizeEnvironmentPath(right.projectUri.fsPath) &&
      normalizeEnvironmentPath(left.manifestUri.fsPath) ===
        normalizeEnvironmentPath(right.manifestUri.fsPath) &&
      normalizeEnvironmentPath(left.prefix) === normalizeEnvironmentPath(right.prefix) &&
      left.environmentName === right.environmentName
    );
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
            `Edit ${route.manifestUri.fsPath} directly, apply the workspace change, then refresh Conda Code.`,
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
    runHeadless: boolean,
  ): Promise<boolean> {
    if (groups.every(({ location }) => location.environment !== undefined)) {
      return true;
    }
    if (runHeadless) {
      return false;
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
        cached.pkgId.environmentId === environment.envId.id &&
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
