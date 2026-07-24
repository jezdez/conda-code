import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CreateEnvironmentOptions,
  CreateEnvironmentScope,
  DidChangeEnvironmentEventArgs,
  DidChangeEnvironmentsEventArgs,
  EnvironmentManager,
  GetEnvironmentScope,
  GetEnvironmentsScope,
  PythonEnvironment,
  PythonEnvironmentApi,
  PythonEnvironmentInfo,
  RefreshEnvironmentsScope,
  ResolveEnvironmentContext,
  SetEnvironmentScope,
} from '@vscode/python-environments';
import {
  Disposable,
  EventEmitter,
  LogOutputChannel,
  ThemeIcon,
  Uri,
  window,
  workspace,
} from 'vscode';

import { diffEnvironments } from './changes';
import { CondaClient } from './conda';
import {
  condaPrefixCandidates,
  condaGlobalEnvironmentRoots,
  inspectCondaPrefix,
  isCondaGlobalPrefix,
  isPixiEnvironmentPrefix,
  isPathWithin,
  isRemovableCondaPrefix,
  isRemovableManagedProjectPrefix,
  pythonExecutablePath,
  type CondaPrefixKind,
  type CondaPrefixMetadata,
} from './prefixes';
import { CondaSelectionState } from './selectionState';
import { condaShellCommands } from './shellActivation';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteConflictError,
  CondaWorkspaceRouteManager,
  CondaWorkspaceRouteRegistry,
  dependencyFeature,
  normalizeEnvironmentPath,
  reconcileWorkspaceRouteClaims,
} from './workspaceRouting';
import {
  CondaWorkspacesClient,
  FailedWorkspaceEnvironmentDiscovery,
  InstalledWorkspaceEnvironment,
  WorkspaceEnvironment,
  WorkspaceInfo,
} from './workspaces';

const MANIFEST_NAMES = ['conda.toml', 'pixi.toml', 'pyproject.toml'] as const;
const MANIFEST_EXCLUDE = '**/{.git,.conda,.pixi,node_modules}/**';

interface DiscoveredWorkspace {
  readonly projectUri: Uri;
  readonly manifestUri: Uri;
  readonly info: WorkspaceInfo;
  readonly environments: readonly PythonEnvironment[];
  readonly featuresByPrefix: ReadonlyMap<string, readonly string[]>;
  readonly directCondaDependenciesByPrefix: ReadonlyMap<string, readonly string[]>;
  readonly environmentFailures: readonly FailedWorkspaceEnvironmentDiscovery[];
}

interface FailedWorkspaceDiscovery {
  readonly manifestUri: Uri;
  readonly projectUri?: Uri;
}

interface WorkspaceDiscovery {
  readonly workspaces: readonly DiscoveredWorkspace[];
  readonly failures: readonly FailedWorkspaceDiscovery[];
}

interface CachedPythonEnvironment {
  readonly fingerprint: string;
  readonly item: PythonEnvironment;
}

type CreateKind = 'workspace' | 'prefix' | 'named';

export interface CondaEnvironmentManagerOptions {
  readonly log?: LogOutputChannel;
  readonly shouldHandleManifest?: (manifest: Uri) => boolean | Promise<boolean>;
}

export class CondaBaseRemovalError extends Error {
  public constructor() {
    super('The base conda environment cannot be removed');
    this.name = 'CondaBaseRemovalError';
  }
}

export class CondaEnvironmentExistsError extends Error {
  public constructor(prefix: string) {
    super(`A file or directory already exists at ${prefix}`);
    this.name = 'CondaEnvironmentExistsError';
  }
}

export class CondaEnvironmentRemovalError extends Error {
  public constructor(prefix: string) {
    super(
      `Conda Code can remove named environments and project .conda prefixes, but ${prefix} ` +
        'does not have enough ownership information for safe removal',
    );
    this.name = 'CondaEnvironmentRemovalError';
  }
}

export class CondaEnvironmentSelectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CondaEnvironmentSelectionError';
  }
}

export class CondaWorkspaceCreationError extends Error {
  public constructor(project: string) {
    super(`Conda Code does not create a conda workspace in ${project}`);
    this.name = 'CondaWorkspaceCreationError';
  }
}

function uriKey(uri: Uri): string {
  return uri.toString(true);
}

function selectionKey(uri: Uri | undefined): string {
  return uri === undefined ? 'global' : uriKey(uri);
}

function isWithin(root: Uri, candidate: Uri): boolean {
  return (
    root.scheme === 'file' &&
    candidate.scheme === 'file' &&
    isPathWithin(root.fsPath, candidate.fsPath)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCurrentEnvironment(current: PythonEnvironment, candidate: PythonEnvironment): boolean {
  return (
    current.envId.id === candidate.envId.id && current.envId.managerId === candidate.envId.managerId
  );
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

function containsPythonSpec(specs: readonly string[]): boolean {
  return specs.some((spec) => /^(?:[^:\s]+::)?python(?:$|[\s<>=!~])/i.test(spec.trim()));
}

function environmentSpecs(options: CreateEnvironmentOptions): string[] {
  const additional = (options.additionalPackages ?? []).filter((spec) => spec.trim() !== '');
  return containsPythonSpec(additional)
    ? [...new Set(additional)]
    : ['python', ...new Set(additional)];
}

function expectedWorkspacePythonPath(prefix: string): string {
  return pythonExecutablePath(prefix, process.platform === 'win32' ? 'win-64' : 'linux-64');
}

export class CondaEnvironmentManager
  implements EnvironmentManager, CondaWorkspaceRouteManager, Disposable
{
  public readonly name = 'conda';
  public readonly displayName = 'Conda Code';
  public readonly description = 'Conda environments and conda workspace environments';
  public readonly iconPath = new ThemeIcon('symbol-folder');
  public readonly preferredPackageManagerId: string;
  public readonly log?: LogOutputChannel;

  private readonly routes = new CondaWorkspaceRouteRegistry();
  private readonly workspacesByProject = new Map<string, DiscoveredWorkspace>();
  private readonly workspaceRoutesByManifest = new Map<string, readonly CondaWorkspaceRoute[]>();
  private readonly environmentItemsByPrefix = new Map<string, CachedPythonEnvironment>();
  private readonly activeByScope = new Map<string, PythonEnvironment>();
  private readonly scopeUris = new Map<string, Uri | undefined>();
  private regularEnvironments: readonly PythonEnvironment[] = [];
  private regularKindsByPrefix = new Map<string, CondaPrefixKind>();
  private additionalRegularPrefixes = new Set<string>();
  private protectedRegularPrefixes = new Set<string>();
  private reservedWorkspacePrefixes = new Set<string>();
  private reservedWorkspaceProjectRoots: readonly Uri[] = [];
  private rootPrefix: string | undefined;
  private readonly onDidChangeEnvironmentEmitter =
    new EventEmitter<DidChangeEnvironmentEventArgs>();
  private readonly onDidChangeEnvironmentsEmitter =
    new EventEmitter<DidChangeEnvironmentsEventArgs>();
  private initialization: Promise<void> | undefined;
  private refreshQueue: Promise<void> = Promise.resolve();

  public readonly onDidChangeEnvironment = this.onDidChangeEnvironmentEmitter.event;
  public readonly onDidChangeEnvironments = this.onDidChangeEnvironmentsEmitter.event;

  public constructor(
    private readonly api: PythonEnvironmentApi,
    private readonly conda: CondaClient,
    private readonly workspaces: CondaWorkspacesClient,
    private readonly selectionState: CondaSelectionState,
    preferredPackageManagerId: string,
    private readonly options: CondaEnvironmentManagerOptions = {},
  ) {
    if (preferredPackageManagerId.trim() === '') {
      throw new TypeError('preferredPackageManagerId must not be empty');
    }
    this.preferredPackageManagerId = preferredPackageManagerId;
    this.log = options.log;
  }

  public quickCreateConfig() {
    return {
      description: 'Create a conda workspace with Python',
      detail: 'Creates conda.toml and installs its default environment',
    };
  }

  public async create(
    scope: CreateEnvironmentScope,
    options: CreateEnvironmentOptions = {},
  ): Promise<PythonEnvironment | undefined> {
    await this.refresh(scope === 'global' || Array.isArray(scope) ? undefined : scope);

    const scopeUri =
      scope === 'global' || (Array.isArray(scope) && scope.length !== 1)
        ? undefined
        : Array.isArray(scope)
          ? scope[0]
          : scope;
    const existingProject = scopeUri === undefined ? undefined : this.owningProject(scopeUri);
    const existingWorkspace =
      existingProject === undefined
        ? undefined
        : this.workspacesByProject.get(uriKey(existingProject));
    if (existingWorkspace !== undefined) {
      return this.installDeclaredEnvironment(existingWorkspace, options);
    }

    if (scopeUri === undefined) {
      return this.createNamedEnvironment(undefined, options);
    }

    const projectUri = this.projectUriForCreation(scopeUri);
    if (projectUri === undefined || projectUri.scheme !== 'file') {
      return undefined;
    }

    const canCreateWorkspace = await this.canCreateWorkspace(projectUri);
    if (options.quickCreate === true && !canCreateWorkspace) {
      throw new CondaWorkspaceCreationError(projectUri.fsPath);
    }
    const kind = await this.selectCreateKind(options.quickCreate, canCreateWorkspace);
    if (kind === undefined) {
      return undefined;
    }
    if (kind === 'workspace') {
      return this.createWorkspace(projectUri, options);
    }
    if (kind === 'prefix') {
      return this.createProjectPrefix(projectUri, options);
    }
    return this.createNamedEnvironment(projectUri, options);
  }

  public async remove(environment: PythonEnvironment): Promise<void> {
    await this.ensureInitialized();
    const prefix = environment.environmentPath.fsPath;
    if (this.routes.isConflictedPrefix(prefix)) {
      throw new CondaWorkspaceRouteConflictError(prefix);
    }
    const current = this.getEnvironmentForPrefix(prefix);
    if (current === undefined) {
      return;
    }
    if (!isCurrentEnvironment(current, environment)) {
      throw new CondaEnvironmentRemovalError(prefix);
    }
    const route = this.routes.getRoute(current);
    if (route !== undefined) {
      await this.workspaces.cleanEnvironment(route.manifestUri.fsPath, route.environmentName);
      await this.refresh(route.projectUri);
      return;
    }

    if (
      this.rootPrefix !== undefined &&
      normalizeEnvironmentPath(current.environmentPath.fsPath) ===
        normalizeEnvironmentPath(this.rootPrefix)
    ) {
      throw new CondaBaseRemovalError();
    }
    if (!(await this.isRegularEnvironmentRemovable(current))) {
      throw new CondaEnvironmentRemovalError(current.environmentPath.fsPath);
    }
    await this.conda.removeEnvironment(current.environmentPath.fsPath);
    await this.refresh(undefined);
  }

  public refresh(scope: RefreshEnvironmentsScope): Promise<void> {
    void scope;
    const refresh = this.refreshQueue.catch(() => undefined).then(() => this.refreshAll());
    this.refreshQueue = refresh;
    const initialized = refresh.catch((error: unknown) => {
      if (this.initialization === initialized) {
        this.initialization = undefined;
      }
      throw error;
    });
    this.initialization = initialized;
    return initialized;
  }

  public async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
    await this.ensureInitialized();
    if (scope === 'all') {
      return this.allEnvironments();
    }
    if (scope === 'global') {
      if (this.rootPrefix === undefined) {
        return [];
      }
      const expectedRoot = normalizeEnvironmentPath(this.rootPrefix);
      return this.regularEnvironments.filter(
        (environment) =>
          normalizeEnvironmentPath(environment.environmentPath.fsPath) === expectedRoot,
      );
    }

    return this.mergeEnvironments(
      this.regularEnvironmentsForScope(scope),
      this.workspacesForScope(scope).flatMap((entry) => entry.environments),
    );
  }

  public async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
    await this.ensureInitialized();
    const selected =
      environment === undefined
        ? undefined
        : this.getEnvironmentForPrefix(environment.environmentPath.fsPath);
    if (
      environment !== undefined &&
      (selected === undefined || !isCurrentEnvironment(selected, environment))
    ) {
      throw new CondaEnvironmentSelectionError(
        `Conda Code does not own the selected environment ${environment.environmentPath.fsPath}`,
      );
    }

    const route = selected === undefined ? undefined : this.routes.getRoute(selected);
    const scopes = scope === undefined ? [undefined] : Array.isArray(scope) ? scope : [scope];
    const selectedScopes = scopes.map((requestedScope) =>
      requestedScope === undefined ? undefined : this.projectUriForSelection(requestedScope),
    );
    if (route !== undefined) {
      for (const selectedScope of selectedScopes) {
        if (selectedScope === undefined || uriKey(route.projectUri) !== uriKey(selectedScope)) {
          throw new CondaEnvironmentSelectionError(
            `Workspace environment ${route.prefix} belongs to ` +
              `${route.projectUri.fsPath}, not the requested scope`,
          );
        }
      }
    }

    for (const selectedScope of selectedScopes) {
      const key = selectionKey(selectedScope);
      const oldEnvironment = this.activeByScope.get(key);
      if (selected === undefined) {
        this.activeByScope.delete(key);
        this.scopeUris.delete(key);
      } else {
        this.activeByScope.set(key, selected);
        this.scopeUris.set(key, selectedScope);
      }
      await this.selectionState.set(selectedScope, selected?.environmentPath.fsPath);
      this.fireSelectionChange(selectedScope, oldEnvironment, selected);
    }
  }

  public async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
    await this.ensureInitialized();
    const selectedScope = scope === undefined ? undefined : this.projectUriForSelection(scope);
    return (
      this.activeByScope.get(selectionKey(selectedScope)) ??
      (selectedScope === undefined ? undefined : this.activeByScope.get('global'))
    );
  }

  public async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
    await this.ensureInitialized();
    if (context.scheme !== 'file') {
      return undefined;
    }

    const route = this.routes.getRouteByContext(context);
    if (route !== undefined) {
      return this.getEnvironmentForRoute(route);
    }

    const expected = normalizeEnvironmentPath(context.fsPath);
    for (const environment of this.allEnvironments()) {
      if (
        normalizeEnvironmentPath(environment.environmentPath.fsPath) === expected ||
        normalizeEnvironmentPath(environment.execInfo.run.executable) === expected
      ) {
        return environment;
      }
    }

    const info = await this.conda.getInfo();
    const globalRoots = condaGlobalEnvironmentRoots();
    for (const candidate of condaPrefixCandidates(context.fsPath)) {
      const metadata = await inspectCondaPrefix(candidate, info);
      if (
        metadata === undefined ||
        isCondaGlobalPrefix(metadata.prefix, globalRoots) ||
        isPixiEnvironmentPrefix(metadata.prefix) ||
        this.routes.isConflictedPrefix(metadata.prefix) ||
        this.reservedWorkspacePrefixes.has(normalizeEnvironmentPath(metadata.prefix)) ||
        this.reservedWorkspaceProjectRoots.some(
          (project) => project.scheme === 'file' && isPathWithin(project.fsPath, metadata.prefix),
        )
      ) {
        continue;
      }
      const previous = this.allEnvironments();
      const environment = this.toRegularPythonEnvironment(metadata, info.rootPrefix);
      const prefixKey = normalizeEnvironmentPath(metadata.prefix);
      this.regularEnvironments = this.mergeEnvironments(this.regularEnvironments, [environment]);
      this.regularKindsByPrefix.set(prefixKey, metadata.kind);
      this.additionalRegularPrefixes.add(metadata.prefix);
      if (metadata.condaInstallation) {
        this.protectedRegularPrefixes.add(prefixKey);
      }
      const changes = diffEnvironments(previous, this.allEnvironments());
      if (changes.length > 0) {
        this.onDidChangeEnvironmentsEmitter.fire(changes);
      }
      return environment;
    }
    return undefined;
  }

  public async clearCache(): Promise<void> {
    await this.refreshQueue.catch(() => undefined);
    const environments = this.allEnvironments();
    const active = new Map(this.activeByScope);
    const scopes = new Map(this.scopeUris);

    this.initialization = undefined;
    this.rootPrefix = undefined;
    this.regularEnvironments = [];
    this.regularKindsByPrefix.clear();
    this.additionalRegularPrefixes.clear();
    this.protectedRegularPrefixes.clear();
    this.reservedWorkspacePrefixes.clear();
    this.reservedWorkspaceProjectRoots = [];
    this.workspacesByProject.clear();
    this.workspaceRoutesByManifest.clear();
    this.activeByScope.clear();
    this.scopeUris.clear();
    this.environmentItemsByPrefix.clear();
    this.routes.clear();

    const changes = diffEnvironments(environments, []);
    if (changes.length > 0) {
      this.onDidChangeEnvironmentsEmitter.fire(changes);
    }
    for (const [key, oldEnvironment] of active) {
      this.fireSelectionChange(scopes.get(key), oldEnvironment, undefined);
    }
  }

  public getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routes.getRoute(environment);
  }

  public dispose(): void {
    this.onDidChangeEnvironmentEmitter.dispose();
    this.onDidChangeEnvironmentsEmitter.dispose();
    this.regularEnvironments = [];
    this.regularKindsByPrefix.clear();
    this.additionalRegularPrefixes.clear();
    this.protectedRegularPrefixes.clear();
    this.reservedWorkspacePrefixes.clear();
    this.reservedWorkspaceProjectRoots = [];
    this.workspacesByProject.clear();
    this.workspaceRoutesByManifest.clear();
    this.activeByScope.clear();
    this.scopeUris.clear();
    this.environmentItemsByPrefix.clear();
    this.routes.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization === undefined) {
      await this.refresh(undefined);
      return;
    }
    await this.initialization;
  }

  private async refreshAll(): Promise<void> {
    const previousEnvironments = this.allEnvironments();
    const previousActive = new Map(this.activeByScope);
    const previousScopes = new Map(this.scopeUris);
    const previousCache = new Map(this.environmentItemsByPrefix);
    let nextState: {
      readonly routeEntries: readonly CondaWorkspaceRoute[];
      readonly workspaceRoutesByManifest: ReadonlyMap<string, readonly CondaWorkspaceRoute[]>;
      readonly condaInfo: Awaited<ReturnType<CondaClient['getInfo']>>;
      readonly regularEnvironments: readonly PythonEnvironment[];
      readonly regularKindsByPrefix: ReadonlyMap<string, CondaPrefixKind>;
      readonly additionalRegularPrefixes: ReadonlySet<string>;
      readonly protectedRegularPrefixes: ReadonlySet<string>;
      readonly reservedWorkspacePrefixes: ReadonlySet<string>;
      readonly reservedWorkspaceProjectRoots: readonly Uri[];
      readonly workspaces: readonly DiscoveredWorkspace[];
      readonly environments: readonly PythonEnvironment[];
      readonly activeByScope: ReadonlyMap<string, PythonEnvironment>;
      readonly scopeUris: ReadonlyMap<string, Uri | undefined>;
      readonly invalidSelections: readonly (Uri | undefined)[];
    };

    try {
      const condaInfo = await this.conda.getInfo();
      const workspaceDiscovery = await this.discoverWorkspaces(condaInfo.platform);
      const globalRoots = condaGlobalEnvironmentRoots();
      const failedManifestKeys = new Set<string>();
      const failedProjectRoots: Uri[] = [];
      for (const failure of workspaceDiscovery.failures) {
        const manifestKey = normalizeEnvironmentPath(failure.manifestUri.fsPath);
        const explicitManifest = path.basename(failure.manifestUri.fsPath) !== 'pyproject.toml';
        if (!explicitManifest && !this.workspaceRoutesByManifest.has(manifestKey)) {
          continue;
        }
        failedManifestKeys.add(manifestKey);
        if (failure.projectUri !== undefined) {
          failedProjectRoots.push(failure.projectUri);
          continue;
        }
        const previousRoute = this.workspaceRoutesByManifest.get(manifestKey)?.[0];
        if (previousRoute !== undefined) {
          failedProjectRoots.push(previousRoute.projectUri);
        }
      }
      const successfulManifestKeys = new Set(
        workspaceDiscovery.workspaces.map((entry) =>
          normalizeEnvironmentPath(entry.manifestUri.fsPath),
        ),
      );
      const preservedWorkspaces = [...this.workspacesByProject.values()].filter((entry) => {
        const manifestKey = normalizeEnvironmentPath(entry.manifestUri.fsPath);
        return failedManifestKeys.has(manifestKey) && !successfulManifestKeys.has(manifestKey);
      });
      const workspaceCandidates = [...workspaceDiscovery.workspaces, ...preservedWorkspaces];
      const currentRoutesByManifest = new Map<string, readonly CondaWorkspaceRoute[]>();
      for (const entry of workspaceCandidates) {
        currentRoutesByManifest.set(
          normalizeEnvironmentPath(entry.manifestUri.fsPath),
          entry.environments
            .map((environment) => this.routeFromEnvironment(entry, environment))
            .filter((route): route is CondaWorkspaceRoute => route !== undefined),
        );
      }
      const workspaceRoutesByManifest = reconcileWorkspaceRouteClaims(
        currentRoutesByManifest,
        failedManifestKeys,
        this.workspaceRoutesByManifest,
      );
      const routeEntries = [...workspaceRoutesByManifest.values()]
        .flat()
        .filter((route) => !isCondaGlobalPrefix(route.prefix, globalRoots));
      const routes = new CondaWorkspaceRouteRegistry();
      routes.replaceAll(routeEntries);
      const workspacePrefixes = new Set(
        [
          ...workspaceCandidates.flatMap((entry) =>
            entry.environments.map((environment) => environment.environmentPath.fsPath),
          ),
          ...workspaceCandidates.flatMap((entry) =>
            entry.environmentFailures.flatMap((failure) =>
              failure.prefix === undefined ? [] : [failure.prefix],
            ),
          ),
          ...[...workspaceRoutesByManifest.values()].flat().map((route) => route.prefix),
        ].map(normalizeEnvironmentPath),
      );
      const workspaces = workspaceCandidates.map((entry) => ({
        ...entry,
        environments: entry.environments.filter(
          (environment) =>
            !isCondaGlobalPrefix(environment.environmentPath.fsPath, globalRoots) &&
            !routes.isConflictedPrefix(environment.environmentPath.fsPath),
        ),
      }));
      const incompleteProjectRoots = workspaceCandidates
        .filter((entry) =>
          entry.environmentFailures.some((failure) => failure.prefix === undefined),
        )
        .map((entry) => entry.projectUri);
      const reservedWorkspaceProjectRoots = [...failedProjectRoots, ...incompleteProjectRoots];
      const regular = await this.discoverRegularEnvironments(
        condaInfo,
        workspacePrefixes,
        globalRoots,
        reservedWorkspaceProjectRoots,
      );
      const environments = this.mergeEnvironments(
        regular.environments,
        workspaces.flatMap((entry) => entry.environments),
      );
      const environmentsByPrefix = new Map(
        environments.map((environment) => [
          normalizeEnvironmentPath(environment.environmentPath.fsPath),
          environment,
        ]),
      );
      const activeByScope = new Map<string, PythonEnvironment>();
      const scopeUris = new Map<string, Uri | undefined>();
      const invalidSelections: (Uri | undefined)[] = [];
      const unverifiedProjectRoots = [
        ...failedProjectRoots,
        ...workspaceCandidates
          .filter((entry) => entry.environmentFailures.length > 0)
          .map((entry) => entry.projectUri),
      ];
      const failedEnvironmentPrefixes = new Set(
        workspaceCandidates
          .flatMap((entry) => entry.environmentFailures)
          .flatMap((failure) => (failure.prefix === undefined ? [] : [failure.prefix]))
          .map(normalizeEnvironmentPath),
      );
      const storedSelections = await this.selectionState.entries();
      for (const [storedKey, prefix] of Object.entries(storedSelections)) {
        const scope = storedKey === 'global' ? undefined : Uri.parse(storedKey, true);
        const key = selectionKey(scope);
        const environment = environmentsByPrefix.get(normalizeEnvironmentPath(prefix));
        const route = environment === undefined ? undefined : routes.getRoute(environment);
        const unverifiedSelection =
          environment === undefined &&
          ((scope !== undefined &&
            unverifiedProjectRoots.some((project) => uriKey(project) === uriKey(scope))) ||
            failedEnvironmentPrefixes.has(normalizeEnvironmentPath(prefix)));
        if (
          (environment === undefined && !unverifiedSelection) ||
          (scope === undefined && route !== undefined) ||
          (scope !== undefined && route !== undefined && uriKey(route.projectUri) !== uriKey(scope))
        ) {
          invalidSelections.push(scope);
          continue;
        }
        if (environment !== undefined) {
          activeByScope.set(key, environment);
          scopeUris.set(key, scope);
        }
      }

      if (!activeByScope.has('global')) {
        const fallbackPrefixes = [
          condaInfo.activePrefix,
          condaInfo.defaultPrefix,
          condaInfo.rootPrefix,
        ].filter((prefix): prefix is string => prefix !== null);
        for (const fallbackPrefix of new Set(fallbackPrefixes.map(normalizeEnvironmentPath))) {
          const fallback = environmentsByPrefix.get(fallbackPrefix);
          if (fallback !== undefined && routes.getRoute(fallback) === undefined) {
            activeByScope.set('global', fallback);
            scopeUris.set('global', undefined);
            break;
          }
        }
      }

      nextState = {
        routeEntries,
        workspaceRoutesByManifest,
        condaInfo,
        regularEnvironments: regular.environments,
        regularKindsByPrefix: regular.kindsByPrefix,
        additionalRegularPrefixes: regular.additionalPrefixes,
        protectedRegularPrefixes: regular.protectedPrefixes,
        reservedWorkspacePrefixes: failedEnvironmentPrefixes,
        reservedWorkspaceProjectRoots,
        workspaces,
        environments,
        activeByScope,
        scopeUris,
        invalidSelections,
      };
    } catch (error) {
      this.environmentItemsByPrefix.clear();
      for (const [prefix, cached] of previousCache) {
        this.environmentItemsByPrefix.set(prefix, cached);
      }
      throw error;
    }

    const discoveredPrefixes = new Set(
      nextState.environments.map((environment) =>
        normalizeEnvironmentPath(environment.environmentPath.fsPath),
      ),
    );
    for (const prefix of this.environmentItemsByPrefix.keys()) {
      if (!discoveredPrefixes.has(prefix)) {
        this.environmentItemsByPrefix.delete(prefix);
      }
    }
    this.routes.replaceAll(nextState.routeEntries);
    this.rootPrefix = nextState.condaInfo.rootPrefix;
    this.regularEnvironments = nextState.regularEnvironments;
    this.regularKindsByPrefix = new Map(nextState.regularKindsByPrefix);
    this.additionalRegularPrefixes = new Set(nextState.additionalRegularPrefixes);
    this.protectedRegularPrefixes = new Set(nextState.protectedRegularPrefixes);
    this.reservedWorkspacePrefixes = new Set(nextState.reservedWorkspacePrefixes);
    this.reservedWorkspaceProjectRoots = [...nextState.reservedWorkspaceProjectRoots];
    this.workspacesByProject.clear();
    for (const entry of nextState.workspaces) {
      this.workspacesByProject.set(uriKey(entry.projectUri), entry);
    }
    this.workspaceRoutesByManifest.clear();
    for (const [manifest, routes] of nextState.workspaceRoutesByManifest) {
      this.workspaceRoutesByManifest.set(manifest, routes);
    }
    this.activeByScope.clear();
    for (const [key, environment] of nextState.activeByScope) {
      this.activeByScope.set(key, environment);
    }
    this.scopeUris.clear();
    for (const [key, scope] of nextState.scopeUris) {
      this.scopeUris.set(key, scope);
    }

    const changes = diffEnvironments(previousEnvironments, nextState.environments);
    if (changes.length > 0) {
      this.onDidChangeEnvironmentsEmitter.fire(changes);
    }
    for (const [key, environment] of nextState.activeByScope) {
      const scope = nextState.scopeUris.get(key);
      this.fireSelectionChange(scope, previousActive.get(key), environment);
      previousActive.delete(key);
    }
    for (const [key, oldEnvironment] of previousActive) {
      this.fireSelectionChange(previousScopes.get(key), oldEnvironment, undefined);
    }
    for (const scope of nextState.invalidSelections) {
      try {
        await this.selectionState.set(scope, undefined);
      } catch (error) {
        this.log?.warn(`Could not clear an invalid conda selection: ${errorMessage(error)}`);
      }
    }
  }

  private async discoverRegularEnvironments(
    info: Awaited<ReturnType<CondaClient['getInfo']>>,
    workspacePrefixes: ReadonlySet<string>,
    globalRoots: readonly string[],
    reservedProjectRoots: readonly Uri[],
  ): Promise<{
    readonly environments: readonly PythonEnvironment[];
    readonly kindsByPrefix: ReadonlyMap<string, CondaPrefixKind>;
    readonly additionalPrefixes: ReadonlySet<string>;
    readonly protectedPrefixes: ReadonlySet<string>;
  }> {
    const additionalPrefixKeys = new Set(
      [...this.additionalRegularPrefixes].map(normalizeEnvironmentPath),
    );
    const prefixes = [
      ...new Map(
        [info.rootPrefix, ...info.envs, ...this.additionalRegularPrefixes].map((prefix) => [
          normalizeEnvironmentPath(prefix),
          prefix,
        ]),
      ).values(),
    ];
    const metadata = await Promise.all(
      prefixes
        .filter(
          (prefix) =>
            !workspacePrefixes.has(normalizeEnvironmentPath(prefix)) &&
            !isCondaGlobalPrefix(prefix, globalRoots) &&
            !isPixiEnvironmentPrefix(prefix) &&
            !reservedProjectRoots.some(
              (project) => project.scheme === 'file' && isPathWithin(project.fsPath, prefix),
            ),
        )
        .map((prefix) => inspectCondaPrefix(prefix, info)),
    );
    const environments = metadata
      .filter((item): item is CondaPrefixMetadata => item !== undefined)
      .map((item) => this.toRegularPythonEnvironment(item, info.rootPrefix));
    const kindsByPrefix = new Map(
      metadata
        .filter((item): item is CondaPrefixMetadata => item !== undefined)
        .map((item) => [normalizeEnvironmentPath(item.prefix), item.kind]),
    );
    const additionalPrefixes = new Set(
      metadata
        .filter(
          (item): item is CondaPrefixMetadata =>
            item !== undefined && additionalPrefixKeys.has(normalizeEnvironmentPath(item.prefix)),
        )
        .map((item) => item.prefix),
    );
    const protectedPrefixes = new Set(
      metadata
        .filter((item): item is CondaPrefixMetadata => item !== undefined && item.condaInstallation)
        .map((item) => normalizeEnvironmentPath(item.prefix)),
    );
    environments.sort((left, right) => left.displayName.localeCompare(right.displayName));
    return { environments, kindsByPrefix, additionalPrefixes, protectedPrefixes };
  }

  private toRegularPythonEnvironment(
    environment: CondaPrefixMetadata,
    rootPrefix: string,
  ): PythonEnvironment {
    const version = environment.pythonVersion ?? 'no-python';
    const displayName = `${environment.name} (${version})`;
    const identifier = environment.kind === 'prefix' ? environment.prefix : environment.name;
    const info: PythonEnvironmentInfo = {
      name: environment.name,
      displayName,
      shortDisplayName: displayName,
      displayPath: environment.prefix,
      version,
      environmentPath: Uri.file(environment.prefix),
      description:
        environment.kind === 'base'
          ? 'conda base environment'
          : environment.kind === 'named'
            ? 'named conda environment'
            : 'conda prefix environment',
      tooltip: environment.prefix,
      iconPath: new ThemeIcon(environment.pythonExists ? 'python' : 'warning'),
      execInfo: {
        run: { executable: environment.pythonPath },
        activatedRun: { executable: environment.pythonPath },
        ...condaShellCommands(rootPrefix, identifier),
      },
      sysPrefix: environment.prefix,
      group:
        environment.kind === 'base' ? undefined : environment.kind === 'named' ? 'Named' : 'Prefix',
      ...(environment.pythonExists && environment.pythonVersion !== null
        ? {}
        : { error: 'Python is not installed in this conda environment' }),
    };
    return this.cachedEnvironment(info, ['regular', environment.kind, environment.pythonExists]);
  }

  private async discoverWorkspaces(condaPlatform: string): Promise<WorkspaceDiscovery> {
    const manifestGroups = await Promise.all(
      MANIFEST_NAMES.map((name) => workspace.findFiles(`**/${name}`, MANIFEST_EXCLUDE)),
    );
    const priority = new Map(MANIFEST_NAMES.map((name, index) => [name, index]));
    const candidates = manifestGroups.flat().sort((left, right) => {
      const directoryOrder = path.dirname(left.fsPath).localeCompare(path.dirname(right.fsPath));
      if (directoryOrder !== 0) {
        return directoryOrder;
      }
      return (
        (priority.get(path.basename(left.fsPath) as (typeof MANIFEST_NAMES)[number]) ?? 99) -
        (priority.get(path.basename(right.fsPath) as (typeof MANIFEST_NAMES)[number]) ?? 99)
      );
    });

    const directories = new Set<string>();
    const discovered: DiscoveredWorkspace[] = [];
    const failures: FailedWorkspaceDiscovery[] = [];
    for (const candidate of candidates) {
      const directory = normalizeEnvironmentPath(path.dirname(candidate.fsPath));
      if (directories.has(directory)) {
        continue;
      }

      let candidateProject: Uri | undefined;
      try {
        if (
          this.options.shouldHandleManifest !== undefined &&
          !(await this.options.shouldHandleManifest(candidate))
        ) {
          directories.add(directory);
          continue;
        }
        candidateProject = this.exactPythonProject(Uri.file(path.dirname(candidate.fsPath)));
        if (candidateProject === undefined) {
          this.log?.debug(
            `Ignoring manifest outside a registered Python project root: ${candidate.fsPath}`,
          );
          continue;
        }
        const info = await this.workspaces.getWorkspaceInfo(candidate.fsPath);
        const manifestUri = Uri.file(info.manifest);
        const projectUri = this.exactPythonProject(Uri.file(path.dirname(info.manifest)));
        if (projectUri === undefined) {
          continue;
        }
        const discovery = await this.workspaces.discoverInstalledEnvironments(
          info.manifest,
          condaPlatform,
        );
        const converted = discovery.environments.map((environment) => ({
          source: environment,
          item: this.toWorkspacePythonEnvironment(environment, projectUri, manifestUri, info),
        }));
        const previous = [...this.workspacesByProject.values()].find(
          (entry) =>
            normalizeEnvironmentPath(entry.manifestUri.fsPath) ===
            normalizeEnvironmentPath(manifestUri.fsPath),
        );
        const retained = discovery.failures.flatMap((failure) => {
          const environment = previous?.environments.find(
            (candidate) =>
              (failure.prefix !== undefined &&
                normalizeEnvironmentPath(candidate.environmentPath.fsPath) ===
                  normalizeEnvironmentPath(failure.prefix)) ||
              candidate.name === failure.environmentName,
          );
          return environment === undefined ? [] : [environment];
        });
        const environments = this.mergeEnvironments(
          retained,
          converted.map(({ item }) => item),
        );
        const featuresByPrefix = new Map<string, readonly string[]>();
        const directCondaDependenciesByPrefix = new Map<string, readonly string[]>();
        for (const environment of environments) {
          const prefixKey = normalizeEnvironmentPath(environment.environmentPath.fsPath);
          const current = converted.find(
            ({ item }) => normalizeEnvironmentPath(item.environmentPath.fsPath) === prefixKey,
          )?.source;
          featuresByPrefix.set(
            prefixKey,
            current?.features ?? previous?.featuresByPrefix.get(prefixKey) ?? [],
          );
          directCondaDependenciesByPrefix.set(
            prefixKey,
            current === undefined
              ? (previous?.directCondaDependenciesByPrefix.get(prefixKey) ?? [])
              : Object.keys(current.condaDependencies),
          );
        }
        for (const failure of discovery.failures) {
          this.log?.debug(
            `Could not inspect workspace environment ${failure.environmentName} in ` +
              `${manifestUri.fsPath}: ${errorMessage(failure.error)}`,
          );
        }
        directories.add(directory);
        discovered.push({
          projectUri,
          manifestUri,
          info,
          environments,
          featuresByPrefix,
          directCondaDependenciesByPrefix,
          environmentFailures: discovery.failures,
        });
      } catch (error) {
        const manifestKey = normalizeEnvironmentPath(candidate.fsPath);
        if (
          path.basename(candidate.fsPath) !== 'pyproject.toml' ||
          this.workspaceRoutesByManifest.has(manifestKey)
        ) {
          directories.add(directory);
        }
        failures.push({
          manifestUri: candidate,
          ...(candidateProject === undefined ? {} : { projectUri: candidateProject }),
        });
        this.log?.debug(
          `Could not inspect workspace manifest ${candidate.fsPath}: ${errorMessage(error)}`,
        );
      }
    }

    return { workspaces: discovered, failures };
  }

  private toWorkspacePythonEnvironment(
    environment: InstalledWorkspaceEnvironment,
    projectUri: Uri,
    manifestUri: Uri,
    workspaceInfo: WorkspaceInfo,
  ): PythonEnvironment {
    const prefix = path.normalize(path.resolve(environment.prefix));
    const version = environment.python?.version ?? 'no-python';
    const pythonPath = environment.python?.executable ?? expectedWorkspacePythonPath(prefix);
    const displayName = `${workspaceInfo.name}:${environment.name} (${version})`;
    const info: PythonEnvironmentInfo = {
      name: environment.name,
      displayName,
      shortDisplayName: `${environment.name} (${version})`,
      displayPath: prefix,
      version,
      environmentPath: Uri.file(prefix),
      description: 'conda workspace environment',
      tooltip: manifestUri.fsPath,
      iconPath: new ThemeIcon(environment.python === null ? 'warning' : 'python'),
      execInfo: {
        run: { executable: pythonPath },
        activatedRun: { executable: pythonPath },
      },
      sysPrefix: prefix,
      group: {
        name: workspaceInfo.name,
        description: projectUri.fsPath,
      },
      ...(environment.python === null
        ? { error: 'Python is not installed in this conda workspace environment' }
        : {}),
    };
    return this.cachedEnvironment(info, [
      'workspace',
      workspaceInfo.name,
      projectUri.toString(true),
      manifestUri.toString(true),
    ]);
  }

  private cachedEnvironment(
    info: PythonEnvironmentInfo,
    fingerprintParts: readonly unknown[],
  ): PythonEnvironment {
    const prefix = normalizeEnvironmentPath(info.environmentPath.fsPath);
    const fingerprint = JSON.stringify([
      info.name,
      info.displayName,
      info.version,
      prefix,
      info.execInfo.run.executable,
      info.sysPrefix,
      ...fingerprintParts,
    ]);
    const cached = this.environmentItemsByPrefix.get(prefix);
    if (cached?.fingerprint === fingerprint) {
      return cached.item;
    }

    const item = this.api.createPythonEnvironmentItem(info, this);
    this.environmentItemsByPrefix.set(prefix, { fingerprint, item });
    return item;
  }

  private async installDeclaredEnvironment(
    entry: DiscoveredWorkspace,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const declared = await this.workspaces.listEnvironments(entry.manifestUri.fsPath);
    const candidates = declared.filter((environment) => !environment.installed);
    const selected = await this.selectDeclaredEnvironment(candidates, options.quickCreate);
    if (selected === undefined) {
      return undefined;
    }

    const additionalPackages = (options.additionalPackages ?? []).filter(
      (spec) => spec.trim() !== '',
    );
    const requestedPackages =
      options.quickCreate === true
        ? await this.quickCreateWorkspacePackages(entry, selected, additionalPackages)
        : additionalPackages;
    if (requestedPackages.length > 0) {
      await this.workspaces.addDependencies(entry.manifestUri.fsPath, requestedPackages, {
        feature: dependencyFeature(selected.name, selected.features),
        noInstall: true,
      });
    }
    await this.workspaces.installEnvironment(entry.manifestUri.fsPath, selected.name);
    await this.refresh(entry.projectUri);
    return this.findEnvironment(selected.name, entry.manifestUri.fsPath, entry.projectUri);
  }

  private async quickCreateWorkspacePackages(
    entry: DiscoveredWorkspace,
    environment: WorkspaceEnvironment,
    additionalPackages: readonly string[],
  ): Promise<readonly string[]> {
    const info = await this.workspaces.getEnvironmentInfo(
      entry.manifestUri.fsPath,
      environment.name,
    );
    return containsPythonSpec(Object.keys(info.condaDependencies))
      ? additionalPackages
      : environmentSpecs({ quickCreate: true, additionalPackages: [...additionalPackages] });
  }

  private async selectDeclaredEnvironment(
    candidates: readonly WorkspaceEnvironment[],
    quickCreate: boolean | undefined,
  ): Promise<WorkspaceEnvironment | undefined> {
    if (candidates.length === 0) {
      return undefined;
    }
    if (quickCreate === true || candidates.length === 1) {
      return candidates[0];
    }

    const selected = await window.showQuickPick(
      candidates.map((environment) => ({
        label: environment.name,
        description:
          environment.features.length === 0 ? undefined : environment.features.join(', '),
        environment,
      })),
      {
        placeHolder: 'Select a declared conda workspace environment to install',
      },
    );
    return selected?.environment;
  }

  private async selectCreateKind(
    quickCreate: boolean | undefined,
    canCreateWorkspace: boolean,
  ): Promise<CreateKind | undefined> {
    if (quickCreate === true) {
      return 'workspace';
    }
    const choices: {
      readonly label: string;
      readonly description: string;
      readonly createKind: CreateKind;
    }[] = [];
    if (canCreateWorkspace) {
      choices.push({
        label: 'Conda workspace',
        description: 'Create conda.toml and a managed project environment',
        createKind: 'workspace',
      });
    }
    choices.push(
      {
        label: 'Project prefix',
        description: 'Create a regular conda environment at .conda',
        createKind: 'prefix',
      },
      {
        label: 'Named environment',
        description: 'Create a regular named conda environment',
        createKind: 'named',
      },
    );
    const selected = await window.showQuickPick(choices, {
      placeHolder: 'Choose how Conda Code should create the environment',
    });
    return selected?.createKind;
  }

  private async canCreateWorkspace(projectUri: Uri): Promise<boolean> {
    if (this.options.shouldHandleManifest === undefined) {
      return true;
    }
    for (const name of ['pixi.toml', 'pyproject.toml']) {
      const manifest = Uri.file(path.join(projectUri.fsPath, name));
      if (
        (await pathExists(manifest.fsPath)) &&
        !(await this.options.shouldHandleManifest(manifest))
      ) {
        return false;
      }
    }
    return true;
  }

  private async createWorkspace(
    projectUri: Uri,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const result = await this.workspaces.quickstart(projectUri.fsPath, {
      format: 'conda',
      specs: environmentSpecs(options),
    });
    await this.refresh(projectUri);
    return this.findEnvironment(result.environment, result.manifest, projectUri);
  }

  private async createProjectPrefix(
    projectUri: Uri,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const prefix = path.join(projectUri.fsPath, '.conda');
    if (await pathExists(prefix)) {
      throw new CondaEnvironmentExistsError(prefix);
    }
    const createdPrefix = await this.conda.createPrefixEnvironment(
      prefix,
      environmentSpecs(options),
    );
    try {
      await writeFile(path.join(createdPrefix, '.gitignore'), '*\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      this.log?.debug(
        `Could not create ${path.join(createdPrefix, '.gitignore')}: ${errorMessage(error)}`,
      );
    }
    await this.refresh(projectUri);
    return this.getEnvironmentForPrefix(createdPrefix);
  }

  private async createNamedEnvironment(
    projectUri: Uri | undefined,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const suggested = (projectUri === undefined ? 'conda-env' : path.basename(projectUri.fsPath))
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const name =
      options.quickCreate === true
        ? this.availableNamedEnvironmentName(suggested || 'conda-env')
        : await window.showInputBox({
            title: 'Create named conda environment',
            prompt: 'Environment name',
            value: suggested || 'conda-env',
            validateInput: (value) => {
              const normalized = value.trim();
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
                return 'Use letters, numbers, dots, underscores, and hyphens';
              }
              return ['base', 'root'].includes(normalized.toLowerCase())
                ? `The name ${normalized} is reserved`
                : undefined;
            },
          });
    if (name === undefined) {
      return undefined;
    }
    const prefix = await this.conda.createNamedEnvironment(name, environmentSpecs(options));
    await this.refresh(projectUri);
    return this.getEnvironmentForPrefix(prefix);
  }

  private availableNamedEnvironmentName(suggested: string): string {
    const used = new Set(
      this.regularEnvironments
        .filter(
          (environment) =>
            this.regularKindsByPrefix.get(
              normalizeEnvironmentPath(environment.environmentPath.fsPath),
            ) === 'named',
        )
        .map((environment) => environment.name.toLowerCase()),
    );
    if (!used.has(suggested.toLowerCase())) {
      return suggested;
    }
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${suggested}-${suffix}`;
      if (!used.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  private projectUriForCreation(scope: Uri): Uri | undefined {
    return this.api.getPythonProject(scope)?.uri ?? workspace.getWorkspaceFolder(scope)?.uri;
  }

  private projectUriForSelection(scope: Uri): Uri {
    return (
      this.owningProject(scope) ??
      this.api.getPythonProject(scope)?.uri ??
      workspace.getWorkspaceFolder(scope)?.uri ??
      scope
    );
  }

  private exactPythonProject(projectUri: Uri): Uri | undefined {
    if (projectUri.scheme !== 'file') {
      return undefined;
    }
    const expected = normalizeEnvironmentPath(projectUri.fsPath);
    return this.api
      .getPythonProjects()
      .find(
        (project) =>
          project.uri.scheme === 'file' &&
          normalizeEnvironmentPath(project.uri.fsPath) === expected,
      )?.uri;
  }

  private owningProject(scope: Uri): Uri | undefined {
    const containing = [...this.workspacesByProject.values()]
      .filter((entry) => isWithin(entry.projectUri, scope))
      .sort((left, right) => right.projectUri.fsPath.length - left.projectUri.fsPath.length);
    return containing[0]?.projectUri;
  }

  private workspacesForScope(scope: Uri): DiscoveredWorkspace[] {
    const owner = this.owningProject(scope);
    if (owner !== undefined) {
      const entry = this.workspacesByProject.get(uriKey(owner));
      return entry === undefined ? [] : [entry];
    }
    return [...this.workspacesByProject.values()].filter((entry) =>
      isWithin(scope, entry.projectUri),
    );
  }

  private regularEnvironmentsForScope(scope: Uri): PythonEnvironment[] {
    const selectedScope = this.projectUriForSelection(scope);
    const selected = this.activeByScope.get(selectionKey(selectedScope));
    const directlyResolved =
      scope.scheme === 'file' ? this.getEnvironmentForPrefix(scope.fsPath) : undefined;
    const projectLocal =
      selectedScope.scheme === 'file'
        ? this.regularEnvironments.filter((environment) =>
            isPathWithin(selectedScope.fsPath, environment.environmentPath.fsPath),
          )
        : [];
    return this.mergeEnvironments(
      projectLocal,
      selected !== undefined && this.routes.getRoute(selected) === undefined ? [selected] : [],
      directlyResolved !== undefined && this.routes.getRoute(directlyResolved) === undefined
        ? [directlyResolved]
        : [],
    );
  }

  private async isRegularEnvironmentRemovable(environment: PythonEnvironment): Promise<boolean> {
    const prefix = environment.environmentPath.fsPath;
    const prefixKey = normalizeEnvironmentPath(prefix);
    if (this.protectedRegularPrefixes.has(prefixKey)) {
      return false;
    }
    if (!(await isRemovableCondaPrefix(prefix))) {
      return false;
    }
    const kind = this.regularKindsByPrefix.get(prefixKey);
    if (kind === 'named') {
      return true;
    }
    if (kind !== 'prefix') {
      return false;
    }
    const project = this.api.getPythonProject(environment.environmentPath);
    return (
      project !== undefined && (await isRemovableManagedProjectPrefix(prefix, project.uri.fsPath))
    );
  }

  private allEnvironments(): PythonEnvironment[] {
    return this.mergeEnvironments(
      this.regularEnvironments,
      [...this.workspacesByProject.values()].flatMap((entry) => entry.environments),
    );
  }

  private mergeEnvironments(
    ...groups: readonly (readonly PythonEnvironment[])[]
  ): PythonEnvironment[] {
    const byPrefix = new Map<string, PythonEnvironment>();
    for (const group of groups) {
      for (const environment of group) {
        byPrefix.set(normalizeEnvironmentPath(environment.environmentPath.fsPath), environment);
      }
    }
    return [...byPrefix.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  public getEnvironmentForPrefix(prefix: string): PythonEnvironment | undefined {
    const expected = normalizeEnvironmentPath(prefix);
    return this.allEnvironments().find(
      (environment) => normalizeEnvironmentPath(environment.environmentPath.fsPath) === expected,
    );
  }

  public isConflictedPrefix(prefix: string): boolean {
    return this.routes.isConflictedPrefix(prefix);
  }

  private routeFromEnvironment(
    entry: DiscoveredWorkspace,
    environment: PythonEnvironment,
  ): CondaWorkspaceRoute | undefined {
    const pythonPath = environment.execInfo.run.executable;
    if (pythonPath === '') {
      return undefined;
    }
    const prefix = environment.environmentPath.fsPath;
    const prefixKey = normalizeEnvironmentPath(prefix);
    return {
      projectUri: entry.projectUri,
      manifestUri: entry.manifestUri,
      environmentName: environment.name,
      features: entry.featuresByPrefix.get(prefixKey) ?? [],
      directCondaDependencies: entry.directCondaDependenciesByPrefix.get(prefixKey) ?? [],
      prefix,
      pythonPath,
    };
  }

  public getEnvironmentForRoute(route: CondaWorkspaceRoute): PythonEnvironment | undefined {
    return this.workspacesByProject
      .get(uriKey(route.projectUri))
      ?.environments.find(
        (environment) =>
          normalizeEnvironmentPath(environment.environmentPath.fsPath) ===
          normalizeEnvironmentPath(route.prefix),
      );
  }

  private findEnvironment(
    environmentName: string,
    manifest: string | null,
    fallbackProject: Uri,
  ): PythonEnvironment | undefined {
    const expectedManifest =
      manifest === null
        ? undefined
        : normalizeEnvironmentPath(
            path.isAbsolute(manifest) ? manifest : path.resolve(fallbackProject.fsPath, manifest),
          );
    for (const entry of this.workspacesByProject.values()) {
      if (expectedManifest === undefined && uriKey(entry.projectUri) !== uriKey(fallbackProject)) {
        continue;
      }
      if (
        expectedManifest !== undefined &&
        normalizeEnvironmentPath(entry.manifestUri.fsPath) !== expectedManifest
      ) {
        continue;
      }
      const environment = entry.environments.find(
        (candidate) => candidate.name === environmentName,
      );
      if (environment !== undefined) {
        return environment;
      }
    }
    return undefined;
  }

  private fireSelectionChange(
    scope: Uri | undefined,
    oldEnvironment: PythonEnvironment | undefined,
    newEnvironment: PythonEnvironment | undefined,
  ): void {
    if (oldEnvironment?.envId.id === newEnvironment?.envId.id) {
      return;
    }
    this.onDidChangeEnvironmentEmitter.fire({
      uri: scope,
      old: oldEnvironment,
      new: newEnvironment,
    });
  }
}
