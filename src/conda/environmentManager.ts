import { stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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
import { CondaClient, type CondaInfo } from './conda';
import {
  discoverCondaPrefixes,
  standardCondaRoots,
  type CondaDiscoveryOptions,
  type CondaDiscoveryResult,
} from './discovery';
import { fingerprintDiscoveryPaths } from './discoveryCache';
import {
  condaExecEnvironmentRoots,
  condaGlobalEnvironmentRoots,
  condaPrefixCandidates,
  inspectCondaPrefix,
  isCondaExecPrefix,
  isCondaGlobalPrefix,
  isPixiEnvironmentPrefix,
  isPathWithin,
  isRemovableCondaPrefix,
  isRemovableManagedProjectPrefix,
  pythonExecutablePath,
  type CondaPrefixMetadata,
} from './prefixes';
import { CondaSelectionState } from './selectionState';
import { condaShellCommands } from './shellActivation';
import {
  canonicalEnvironmentPath,
  CondaWorkspaceRoute,
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
  WorkspaceEnvironmentDeclaration,
  WorkspaceInfo,
} from './workspaces';

const MANIFEST_NAMES = ['conda.toml', 'pixi.toml', 'pyproject.toml'] as const;
const PROJECT_ENVIRONMENT_FILE_NAMES = [
  'environment.yml',
  'environment.yaml',
  'explicit.txt',
  'conda-lock.yml',
  'conda-lock.yaml',
] as const;
const PROJECT_LOCK_FILE_NAMES: ReadonlySet<string> = new Set([
  'explicit.txt',
  'conda-lock.yml',
  'conda-lock.yaml',
]);
const MANIFEST_EXCLUDE = '**/{.git,.conda,.pixi,node_modules}/**';

interface DiscoveredWorkspace {
  readonly projectUri: Uri;
  readonly manifestUri: Uri;
  readonly info: WorkspaceInfo;
  readonly snapshotAvailable: boolean;
  readonly declaredEnvironments: readonly WorkspaceEnvironmentDeclaration[];
  readonly environments: readonly PythonEnvironment[];
  readonly detailsByPrefix: ReadonlyMap<string, InstalledWorkspaceEnvironment>;
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

interface RegularDiscoveryCache {
  readonly sourceKey: string;
  readonly fingerprint: string;
  readonly result: CondaDiscoveryResult;
}

type CreateKind = 'workspace' | 'prefix' | 'named';

type CreateChoice =
  | {
      readonly kind: 'definition-file';
      readonly definitionFile: Uri;
    }
  | {
      readonly kind: CreateKind;
    };

export interface CondaEnvironmentManagerOptions {
  readonly log?: LogOutputChannel;
  readonly shouldHandleManifest?: (manifest: Uri) => boolean | Promise<boolean>;
  readonly initialCondaInfo?: CondaInfo;
  readonly enrichCondaInfo?: (options: {
    readonly force: boolean;
    readonly signal: AbortSignal;
  }) => Promise<CondaInfo | undefined>;
  readonly saveCondaInfo?: (info: CondaInfo | undefined) => void | Promise<void>;
  readonly discovery?: Omit<CondaDiscoveryOptions, 'additionalPrefixes' | 'condaExecutable'>;
}

function uriKey(uri: Uri): string {
  return uri.toString(true);
}

function selectionKey(uri: Uri | undefined): string {
  return uri === undefined ? 'global' : uriKey(uri);
}

function selectionScope(key: string): Uri | undefined {
  return key === 'global' ? undefined : Uri.parse(key, true);
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

function discoveryEnvironmentValues(
  environment: NodeJS.ProcessEnv,
): readonly (readonly [string, string])[] {
  const fixedNames = new Set([
    'CONDA_DEFAULT_ENV',
    'CONDA_ENVS_DIRS',
    'CONDA_ENVS_PATH',
    'CONDA_EXE',
    'CONDA_EXEC_HOME',
    'CONDA_GLOBAL_HOME',
    'CONDA_PYTHON_EXE',
    'CONDA_ROOT_PREFIX',
    'LOCALAPPDATA',
    'PATH',
    'Path',
    'path',
    'PATHEXT',
    'PROGRAMDATA',
    'XDG_DATA_HOME',
  ]);
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        value !== undefined && (fixedNames.has(name) || /^CONDA_PREFIX(?:_\d+)?$/i.test(name)),
    )
    .map(([name, value]) => [name, value as string] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function discoverySourceKey(
  info: CondaInfo | undefined,
  primaryRootResolved: boolean,
  condaExecutable: string | undefined,
  additionalPrefixes: ReadonlySet<string>,
  environment: NodeJS.ProcessEnv,
  userHome: string,
  roots: readonly string[],
  includeGlobalSources: boolean,
): string {
  return JSON.stringify({
    info,
    primaryRootResolved,
    condaExecutable,
    additionalPrefixes: [...additionalPrefixes].sort(),
    environment: discoveryEnvironmentValues(environment),
    userHome,
    roots,
    includeGlobalSources,
  });
}

function supportsCondaShellActivation(
  environment: CondaPrefixMetadata,
): environment is CondaPrefixMetadata & { readonly ownerRoot: string } {
  return environment.ownerRoot !== undefined && environment.ownerExecutable !== undefined;
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
  private regularEnvironments: readonly PythonEnvironment[] = [];
  private regularMetadataByPrefix = new Map<string, CondaPrefixMetadata>();
  private additionalRegularPrefixes = new Set<string>();
  private reservedWorkspacePrefixes = new Set<string>();
  private reservedWorkspaceProjectRoots: readonly Uri[] = [];
  private condaInfo: CondaInfo | undefined;
  private condaInfoPrimaryRootResolved = false;
  private regularDiscoveryCache: RegularDiscoveryCache | undefined;
  private regularDiscoveryGeneration = 0;
  private readonly onDidChangeEnvironmentEmitter =
    new EventEmitter<DidChangeEnvironmentEventArgs>();
  private readonly onDidChangeEnvironmentsEmitter =
    new EventEmitter<DidChangeEnvironmentsEventArgs>();
  private hasInitialized = false;
  private refreshQueue: Promise<void> | undefined;
  private refreshAbortController: AbortController | undefined;
  private refreshPending = false;
  private clearQueue: Promise<void> | undefined;
  private clearing = false;
  private condaInfoEnrichment: Promise<void> | undefined;
  private condaInfoEnrichmentAbortController: AbortController | undefined;
  private condaInfoEnrichmentPending = false;
  private disposed = false;

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
    this.condaInfo = options.initialCondaInfo;
    this.condaInfoPrimaryRootResolved = options.initialCondaInfo !== undefined;
  }

  public quickCreateConfig() {
    return {
      description: 'Create a conda environment for this project',
      detail:
        'Uses environment.yml or another supported project file when present. ' +
        'Otherwise creates a conda workspace.',
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

    const definitionFiles = await this.findProjectDefinitionFiles(projectUri);
    const canCreateWorkspace = await this.canCreateWorkspace(projectUri);
    if (options.quickCreate === true && definitionFiles.length === 0 && !canCreateWorkspace) {
      throw new Error(`Conda Code does not create a conda workspace in ${projectUri.fsPath}`);
    }
    const choice = await this.selectCreateChoice(
      options.quickCreate,
      canCreateWorkspace,
      projectUri,
      definitionFiles,
    );
    if (choice === undefined) {
      return undefined;
    }
    if (choice.kind === 'definition-file') {
      return this.createFromProjectDefinition(projectUri, choice.definitionFile, options);
    }
    if (choice.kind === 'workspace') {
      return this.createWorkspace(projectUri, options);
    }
    if (choice.kind === 'prefix') {
      return this.createProjectPrefix(projectUri, options);
    }
    return this.createNamedEnvironment(projectUri, options);
  }

  public async createFromDefinitionFile(
    definitionFile: Uri,
  ): Promise<PythonEnvironment | undefined> {
    const filename = path.basename(definitionFile.fsPath);
    if (
      definitionFile.scheme !== 'file' ||
      !PROJECT_ENVIRONMENT_FILE_NAMES.includes(
        filename as (typeof PROJECT_ENVIRONMENT_FILE_NAMES)[number],
      )
    ) {
      throw new Error(`${definitionFile.fsPath} is not a supported project environment file`);
    }

    const projectUri = this.api.getPythonProject(definitionFile)?.uri;
    if (
      projectUri?.scheme !== 'file' ||
      normalizeEnvironmentPath(path.dirname(definitionFile.fsPath)) !==
        normalizeEnvironmentPath(projectUri.fsPath)
    ) {
      throw new Error(`${filename} must be at the root of a registered Python project`);
    }

    await this.refresh(projectUri);
    const created = await this.createFromProjectDefinition(projectUri, definitionFile, {
      quickCreate: true,
    });
    if (created !== undefined) {
      await this.set(projectUri, created);
    }
    return created;
  }

  public async remove(environment: PythonEnvironment): Promise<void> {
    await this.ensureInitialized(true);
    const prefix = environment.environmentPath.fsPath;
    if (this.routes.isConflictedPrefix(prefix)) {
      throw new Error(`Multiple conda workspace manifests claim the prefix ${prefix}`);
    }
    const current = this.getEnvironmentForPrefix(prefix);
    if (current === undefined) {
      return;
    }
    if (!isCurrentEnvironment(current, environment)) {
      throw new Error(
        `Conda Code can remove named environments and project .conda prefixes, but ${prefix} ` +
          'does not have enough ownership information for safe removal',
      );
    }
    const route = this.routes.getRoute(current);
    if (route !== undefined) {
      await this.workspaces.cleanEnvironment(route.manifestUri.fsPath, route.environmentName);
      await this.refresh(route.projectUri);
      return;
    }

    const metadata = this.regularMetadataByPrefix.get(
      canonicalEnvironmentPath(current.environmentPath.fsPath),
    );
    if (metadata?.kind === 'base') {
      throw new Error('The base conda environment cannot be removed');
    }
    if (!(await this.isRegularEnvironmentRemovable(current))) {
      throw new Error(
        `Conda Code can remove named environments and project .conda prefixes, but ` +
          `${current.environmentPath.fsPath} does not have enough ownership information for safe removal`,
      );
    }
    const owner = metadata?.ownerExecutable;
    if (owner === undefined) {
      throw new Error(
        `Conda Code can remove named environments and project .conda prefixes, but ` +
          `${current.environmentPath.fsPath} does not have enough ownership information for safe removal`,
      );
    }
    await this.conda.forExecutable(owner).removeEnvironment(current.environmentPath.fsPath);
    this.invalidateRegularDiscovery();
    await this.refresh(undefined);
  }

  public refresh(scope: RefreshEnvironmentsScope): Promise<void> {
    void scope;
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.clearQueue !== undefined) {
      return this.clearQueue.then(() => this.refresh(scope));
    }
    if (this.refreshQueue !== undefined) {
      this.refreshPending = true;
      return this.refreshQueue;
    }

    const abortController = new AbortController();
    this.refreshAbortController = abortController;
    const refresh = (async () => {
      do {
        this.refreshPending = false;
        try {
          await this.refreshAll(abortController.signal);
        } catch (error) {
          if (!this.refreshPending) {
            throw error;
          }
        }
      } while (this.refreshPending);
    })();
    const queued = refresh.finally(() => {
      if (this.refreshQueue === queued) {
        this.refreshQueue = undefined;
        if (this.refreshAbortController === abortController) {
          this.refreshAbortController = undefined;
        }
      }
    });
    this.refreshQueue = queued;
    void queued.then(
      () => this.startCondaInfoEnrichment(),
      () => undefined,
    );
    return queued;
  }

  public async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
    await this.ensureInitialized();
    if (scope === 'all') {
      return this.allEnvironments();
    }
    if (scope === 'global') {
      return this.regularEnvironments.filter(
        (environment) =>
          this.regularMetadataByPrefix.get(
            canonicalEnvironmentPath(environment.environmentPath.fsPath),
          )?.kind === 'base',
      );
    }

    return this.mergeEnvironments(
      this.regularEnvironmentsForScope(scope),
      this.workspacesForScope(scope).flatMap((entry) => entry.environments),
    );
  }

  public async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
    await this.ensureInitialized(true);
    const selected =
      environment === undefined
        ? undefined
        : this.getEnvironmentForPrefix(environment.environmentPath.fsPath);
    if (
      environment !== undefined &&
      (selected === undefined || !isCurrentEnvironment(selected, environment))
    ) {
      throw new Error(
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
          throw new Error(
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
      } else {
        this.activeByScope.set(key, selected);
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
    await this.ensureInitialized(true);
    if (context.scheme !== 'file') {
      return undefined;
    }

    const route = this.routes.getRouteByContext(context);
    if (route !== undefined) {
      return this.getEnvironmentForRoute(route);
    }

    const expected = canonicalEnvironmentPath(context.fsPath);
    for (const environment of this.allEnvironments()) {
      if (
        canonicalEnvironmentPath(environment.environmentPath.fsPath) === expected ||
        canonicalEnvironmentPath(environment.execInfo.run.executable) === expected
      ) {
        return environment;
      }
    }

    const info = this.condaInfo;
    if (info === undefined) {
      return undefined;
    }
    const discoveryEnvironment = this.options.discovery?.environment ?? process.env;
    const discoveryUserHome = this.options.discovery?.userHome ?? homedir();
    const execRoots = condaExecEnvironmentRoots(discoveryEnvironment, discoveryUserHome);
    const globalRoots = condaGlobalEnvironmentRoots();
    for (const candidate of condaPrefixCandidates(context.fsPath)) {
      const metadata = await this.inspectRegularPrefix(candidate, info);
      if (
        metadata === undefined ||
        isCondaExecPrefix(metadata.prefix, execRoots) ||
        isCondaGlobalPrefix(metadata.prefix, globalRoots) ||
        isPixiEnvironmentPrefix(metadata.prefix) ||
        this.routes.isConflictedPrefix(metadata.prefix) ||
        this.reservedWorkspacePrefixes.has(canonicalEnvironmentPath(metadata.prefix)) ||
        this.reservedWorkspaceProjectRoots.some(
          (project) => project.scheme === 'file' && isPathWithin(project.fsPath, metadata.prefix),
        )
      ) {
        continue;
      }
      const previous = this.allEnvironments();
      const environment = this.toRegularPythonEnvironment(metadata);
      const prefixKey = canonicalEnvironmentPath(metadata.prefix);
      this.regularEnvironments = this.mergeEnvironments(this.regularEnvironments, [environment]);
      this.regularMetadataByPrefix.set(prefixKey, metadata);
      this.additionalRegularPrefixes.add(metadata.prefix);
      const changes = diffEnvironments(previous, this.allEnvironments());
      if (changes.length > 0) {
        this.onDidChangeEnvironmentsEmitter.fire(changes);
      }
      return environment;
    }
    return undefined;
  }

  public clearCache(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.clearQueue !== undefined) {
      return this.clearQueue;
    }

    this.clearing = true;
    const refresh = this.refreshQueue;
    this.refreshAbortController?.abort();
    const enrichment = this.condaInfoEnrichment;
    this.condaInfoEnrichmentAbortController?.abort();
    this.condaInfoEnrichmentPending = false;
    const clearing = (async () => {
      await Promise.all([refresh?.catch(() => undefined), enrichment?.catch(() => undefined)]);
      if (this.disposed) {
        return;
      }
      const environments = this.allEnvironments();
      const active = new Map(this.activeByScope);

      this.hasInitialized = false;
      this.refreshPending = false;
      this.condaInfo = undefined;
      this.condaInfoPrimaryRootResolved = false;
      this.regularDiscoveryCache = undefined;
      this.regularDiscoveryGeneration += 1;
      this.condaInfoEnrichment = undefined;
      this.condaInfoEnrichmentAbortController = undefined;
      this.regularEnvironments = [];
      this.regularMetadataByPrefix.clear();
      this.additionalRegularPrefixes.clear();
      this.reservedWorkspacePrefixes.clear();
      this.reservedWorkspaceProjectRoots = [];
      this.workspacesByProject.clear();
      this.workspaceRoutesByManifest.clear();
      this.activeByScope.clear();
      this.environmentItemsByPrefix.clear();
      this.routes.clear();
      await this.options.saveCondaInfo?.(undefined);

      const changes = diffEnvironments(environments, []);
      if (changes.length > 0) {
        this.onDidChangeEnvironmentsEmitter.fire(changes);
      }
      for (const [key, oldEnvironment] of active) {
        this.fireSelectionChange(selectionScope(key), oldEnvironment, undefined);
      }
    })();
    const queued = clearing.finally(() => {
      if (this.clearQueue === queued) {
        this.clearQueue = undefined;
        this.clearing = false;
        if (this.condaInfoEnrichmentPending && !this.disposed) {
          this.startCondaInfoEnrichment();
        }
      }
    });
    this.clearQueue = queued;
    return queued;
  }

  public getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routes.getRoute(environment);
  }

  public invalidateRegularDiscovery(): void {
    this.regularDiscoveryCache = undefined;
    this.regularDiscoveryGeneration += 1;
  }

  public invalidateCondaInfo(): void {
    if (this.disposed) {
      return;
    }
    this.condaInfoEnrichmentAbortController?.abort();
    this.condaInfoEnrichmentPending = true;
    this.startCondaInfoEnrichment();
  }

  public async getWorkspaceManifests(): Promise<Uri[]> {
    await this.ensureInitialized();
    return [...this.workspacesByProject.values()].map((entry) => entry.manifestUri);
  }

  public dispose(): void {
    this.disposed = true;
    this.hasInitialized = false;
    this.refreshAbortController?.abort();
    this.refreshAbortController = undefined;
    this.condaInfoEnrichmentAbortController?.abort();
    this.condaInfoEnrichmentAbortController = undefined;
    this.condaInfoEnrichmentPending = false;
    this.condaInfoEnrichment = undefined;
    this.onDidChangeEnvironmentEmitter.dispose();
    this.onDidChangeEnvironmentsEmitter.dispose();
    this.regularEnvironments = [];
    this.regularMetadataByPrefix.clear();
    this.regularDiscoveryCache = undefined;
    this.regularDiscoveryGeneration += 1;
    this.additionalRegularPrefixes.clear();
    this.reservedWorkspacePrefixes.clear();
    this.reservedWorkspaceProjectRoots = [];
    this.workspacesByProject.clear();
    this.workspaceRoutesByManifest.clear();
    this.activeByScope.clear();
    this.environmentItemsByPrefix.clear();
    this.routes.clear();
  }

  private async ensureInitialized(waitForRefresh = false): Promise<void> {
    if (this.hasInitialized) {
      if (waitForRefresh) {
        await this.refreshQueue;
      }
      return;
    }
    if (this.refreshQueue === undefined) {
      await this.refresh(undefined);
      return;
    }
    await this.refreshQueue;
  }

  private async refreshAll(signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted) {
      return;
    }
    const previousEnvironments = this.allEnvironments();
    const previousActive = new Map(this.activeByScope);
    const previousCache = new Map(this.environmentItemsByPrefix);
    let nextState: {
      readonly routeEntries: readonly CondaWorkspaceRoute[];
      readonly workspaceRoutesByManifest: ReadonlyMap<string, readonly CondaWorkspaceRoute[]>;
      readonly condaInfo: Awaited<ReturnType<CondaClient['getInfo']>>;
      readonly regularEnvironments: readonly PythonEnvironment[];
      readonly regularMetadataByPrefix: ReadonlyMap<string, CondaPrefixMetadata>;
      readonly additionalRegularPrefixes: ReadonlySet<string>;
      readonly reservedWorkspacePrefixes: ReadonlySet<string>;
      readonly reservedWorkspaceProjectRoots: readonly Uri[];
      readonly workspaces: readonly DiscoveredWorkspace[];
      readonly environments: readonly PythonEnvironment[];
      readonly activeByScope: ReadonlyMap<string, PythonEnvironment>;
      readonly invalidSelections: readonly (Uri | undefined)[];
    };

    try {
      const regularDiscovery = await this.getDiscovery();
      const condaInfo = regularDiscovery.info;
      if (this.disposed || signal.aborted) {
        this.environmentItemsByPrefix.clear();
        return;
      }
      const workspaceDiscovery = await this.discoverWorkspaces(
        condaInfo.platform,
        condaInfo.rootPrefix,
        signal,
      );
      if (this.disposed || signal.aborted) {
        this.environmentItemsByPrefix.clear();
        return;
      }
      const discoveryEnvironment = this.options.discovery?.environment ?? process.env;
      const discoveryUserHome = this.options.discovery?.userHome ?? homedir();
      const execRoots = condaExecEnvironmentRoots(discoveryEnvironment, discoveryUserHome);
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
        .filter(
          (route) =>
            !isCondaExecPrefix(route.prefix, execRoots) &&
            !isCondaGlobalPrefix(route.prefix, globalRoots),
        );
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
        ].map(canonicalEnvironmentPath),
      );
      const workspaces = workspaceCandidates.map((entry) => ({
        ...entry,
        environments: entry.environments.filter(
          (environment) =>
            !isCondaExecPrefix(environment.environmentPath.fsPath, execRoots) &&
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
      const regular = this.regularEnvironmentsFromDiscovery(
        regularDiscovery,
        workspacePrefixes,
        execRoots,
        globalRoots,
        reservedWorkspaceProjectRoots,
      );
      if (this.disposed || signal.aborted) {
        this.environmentItemsByPrefix.clear();
        return;
      }
      const environments = this.mergeEnvironments(
        regular.environments,
        workspaces.flatMap((entry) => entry.environments),
      );
      const environmentsByPrefix = new Map(
        environments.map((environment) => [
          canonicalEnvironmentPath(environment.environmentPath.fsPath),
          environment,
        ]),
      );
      const activeByScope = new Map<string, PythonEnvironment>();
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
          .map(canonicalEnvironmentPath),
      );
      const storedSelections = await this.selectionState.entries();
      if (this.disposed || signal.aborted) {
        this.environmentItemsByPrefix.clear();
        return;
      }
      for (const [storedKey, prefix] of Object.entries(storedSelections)) {
        const scope = storedKey === 'global' ? undefined : Uri.parse(storedKey, true);
        const key = selectionKey(scope);
        const environment = environmentsByPrefix.get(canonicalEnvironmentPath(prefix));
        const route = environment === undefined ? undefined : routes.getRoute(environment);
        const unverifiedSelection =
          environment === undefined &&
          ((scope !== undefined &&
            unverifiedProjectRoots.some((project) => uriKey(project) === uriKey(scope))) ||
            failedEnvironmentPrefixes.has(canonicalEnvironmentPath(prefix)));
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
        }
      }

      if (!activeByScope.has('global')) {
        const fallbackPrefixes = [
          condaInfo.activePrefix,
          ...(this.condaInfoPrimaryRootResolved
            ? [condaInfo.defaultPrefix, condaInfo.rootPrefix]
            : []),
        ].filter((prefix): prefix is string => prefix !== null);
        for (const fallbackPrefix of new Set(fallbackPrefixes.map(canonicalEnvironmentPath))) {
          const fallback = environmentsByPrefix.get(fallbackPrefix);
          if (fallback !== undefined && routes.getRoute(fallback) === undefined) {
            activeByScope.set('global', fallback);
            break;
          }
        }
      }

      nextState = {
        routeEntries,
        workspaceRoutesByManifest,
        condaInfo,
        regularEnvironments: regular.environments,
        regularMetadataByPrefix: regular.metadataByPrefix,
        additionalRegularPrefixes: regular.additionalPrefixes,
        reservedWorkspacePrefixes: failedEnvironmentPrefixes,
        reservedWorkspaceProjectRoots,
        workspaces,
        environments,
        activeByScope,
        invalidSelections,
      };
    } catch (error) {
      this.environmentItemsByPrefix.clear();
      for (const [prefix, cached] of previousCache) {
        this.environmentItemsByPrefix.set(prefix, cached);
      }
      throw error;
    }

    if (this.disposed || signal.aborted) {
      this.environmentItemsByPrefix.clear();
      return;
    }
    const discoveredPrefixes = new Set(
      nextState.environments.map((environment) =>
        canonicalEnvironmentPath(environment.environmentPath.fsPath),
      ),
    );
    for (const prefix of this.environmentItemsByPrefix.keys()) {
      if (!discoveredPrefixes.has(prefix)) {
        this.environmentItemsByPrefix.delete(prefix);
      }
    }
    this.routes.replaceAll(nextState.routeEntries);
    this.regularEnvironments = nextState.regularEnvironments;
    this.regularMetadataByPrefix = new Map(nextState.regularMetadataByPrefix);
    this.additionalRegularPrefixes = new Set(nextState.additionalRegularPrefixes);
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

    const changes = diffEnvironments(previousEnvironments, nextState.environments);
    if (changes.length > 0) {
      this.onDidChangeEnvironmentsEmitter.fire(changes);
    }
    for (const [key, environment] of nextState.activeByScope) {
      const scope = selectionScope(key);
      this.fireSelectionChange(scope, previousActive.get(key), environment);
      previousActive.delete(key);
    }
    for (const [key, oldEnvironment] of previousActive) {
      this.fireSelectionChange(selectionScope(key), oldEnvironment, undefined);
    }
    for (const scope of nextState.invalidSelections) {
      if (this.disposed || signal.aborted) {
        return;
      }
      try {
        await this.selectionState.set(scope, undefined);
      } catch (error) {
        this.log?.warn(`Could not clear an invalid conda selection: ${errorMessage(error)}`);
      }
    }
    this.hasInitialized = true;
  }

  private async getDiscovery(): Promise<CondaDiscoveryResult> {
    const infoSnapshot = this.condaInfo;
    const condaExecutable =
      typeof this.conda.executable === 'string' && this.conda.executable.trim() !== ''
        ? this.conda.executable
        : undefined;
    let info = this.condaInfo;
    let primaryRootResolved = this.condaInfoPrimaryRootResolved;
    if (info === undefined && condaExecutable === undefined) {
      info = await this.conda.getInfo();
      primaryRootResolved = true;
    }
    const environment = this.options.discovery?.environment ?? process.env;
    const userHome = this.options.discovery?.userHome ?? homedir();
    const includeGlobalSources =
      this.options.discovery?.includeGlobalSources ?? condaExecutable !== undefined;
    const roots =
      this.options.discovery?.standardRoots ??
      (includeGlobalSources ? standardCondaRoots(environment, userHome) : []);
    const sourceKey = discoverySourceKey(
      info,
      primaryRootResolved,
      condaExecutable,
      this.additionalRegularPrefixes,
      environment,
      userHome,
      roots,
      includeGlobalSources,
    );
    const cached = this.regularDiscoveryCache;
    let result: CondaDiscoveryResult;
    if (
      cached !== undefined &&
      cached.sourceKey === sourceKey &&
      (await fingerprintDiscoveryPaths(cached.result.watchPaths)) === cached.fingerprint
    ) {
      result = cached.result;
    } else {
      const generation = this.regularDiscoveryGeneration;
      result = await discoverCondaPrefixes(info, {
        ...this.options.discovery,
        environment,
        userHome,
        standardRoots: roots,
        ...(condaExecutable === undefined ? {} : { condaExecutable }),
        additionalPrefixes: [...this.additionalRegularPrefixes],
        includeGlobalSources,
      });
      const fingerprint = await fingerprintDiscoveryPaths(result.watchPaths);
      if (generation === this.regularDiscoveryGeneration) {
        this.regularDiscoveryCache = {
          sourceKey: discoverySourceKey(
            result.info,
            result.primaryRootResolved,
            condaExecutable,
            this.additionalRegularPrefixes,
            environment,
            userHome,
            roots,
            includeGlobalSources,
          ),
          fingerprint,
          result,
        };
      }
    }
    if (!this.disposed && this.condaInfo === infoSnapshot) {
      this.condaInfo = result.info;
      this.condaInfoPrimaryRootResolved = result.primaryRootResolved;
    }
    return result;
  }

  private startCondaInfoEnrichment(): void {
    if (this.disposed || this.clearing || this.condaInfoEnrichment !== undefined) {
      return;
    }
    const enrichCondaInfo = this.options.enrichCondaInfo;
    if (enrichCondaInfo === undefined) {
      return;
    }
    const force = this.condaInfoEnrichmentPending;
    this.condaInfoEnrichmentPending = false;
    const abortController = new AbortController();
    this.condaInfoEnrichmentAbortController = abortController;
    const enrichment = Promise.resolve()
      .then(() => enrichCondaInfo({ force, signal: abortController.signal }))
      .then(async (info) => {
        if (info === undefined || this.disposed || abortController.signal.aborted) {
          return;
        }
        const changed = JSON.stringify(info) !== JSON.stringify(this.condaInfo);
        try {
          await this.options.saveCondaInfo?.(info);
        } catch (error) {
          this.log?.debug(`Could not save conda discovery information: ${errorMessage(error)}`);
        }
        if (this.disposed || abortController.signal.aborted) {
          return;
        }
        this.condaInfo = info;
        this.condaInfoPrimaryRootResolved = true;
        if (changed) {
          await this.refresh(undefined);
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          this.log?.debug(`Could not enrich conda discovery information: ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (this.condaInfoEnrichment === enrichment) {
          this.condaInfoEnrichment = undefined;
          if (this.condaInfoEnrichmentAbortController === abortController) {
            this.condaInfoEnrichmentAbortController = undefined;
          }
          if (this.condaInfoEnrichmentPending && !this.disposed) {
            this.startCondaInfoEnrichment();
          }
        }
      });
    this.condaInfoEnrichment = enrichment;
  }

  private regularEnvironmentsFromDiscovery(
    discovery: CondaDiscoveryResult,
    workspacePrefixes: ReadonlySet<string>,
    execRoots: readonly string[],
    globalRoots: readonly string[],
    reservedProjectRoots: readonly Uri[],
  ): {
    readonly environments: readonly PythonEnvironment[];
    readonly metadataByPrefix: ReadonlyMap<string, CondaPrefixMetadata>;
    readonly additionalPrefixes: ReadonlySet<string>;
  } {
    const additionalPrefixKeys = new Set(
      [...this.additionalRegularPrefixes].map(canonicalEnvironmentPath),
    );
    const metadata = discovery.metadata.filter(
      (item) =>
        !workspacePrefixes.has(canonicalEnvironmentPath(item.prefix)) &&
        !isCondaExecPrefix(item.prefix, execRoots) &&
        !isCondaGlobalPrefix(item.prefix, globalRoots) &&
        !isPixiEnvironmentPrefix(item.prefix) &&
        !reservedProjectRoots.some(
          (project) => project.scheme === 'file' && isPathWithin(project.fsPath, item.prefix),
        ),
    );
    const environments = metadata.map((item) => this.toRegularPythonEnvironment(item));
    const metadataByPrefix = new Map(
      metadata.map((item) => [canonicalEnvironmentPath(item.prefix), item]),
    );
    const additionalPrefixes = new Set(
      metadata
        .filter((item) => additionalPrefixKeys.has(canonicalEnvironmentPath(item.prefix)))
        .map((item) => item.prefix),
    );
    environments.sort((left, right) => left.displayName.localeCompare(right.displayName));
    return { environments, metadataByPrefix, additionalPrefixes };
  }

  private async inspectRegularPrefix(
    prefix: string,
    info: Awaited<ReturnType<CondaClient['getInfo']>>,
  ): Promise<CondaPrefixMetadata | undefined> {
    const prefixKey = canonicalEnvironmentPath(prefix);
    const ownedByPrimary =
      this.condaInfoPrimaryRootResolved &&
      (prefixKey === canonicalEnvironmentPath(info.rootPrefix) ||
        info.envsDirs.some(
          (directory) => path.dirname(prefixKey) === canonicalEnvironmentPath(directory),
        ));
    const condaExecutable =
      typeof this.conda.executable === 'string' && this.conda.executable.trim() !== ''
        ? this.conda.executable
        : undefined;
    return inspectCondaPrefix(prefix, info, {
      ...(ownedByPrimary ? { ownerRoot: info.rootPrefix, ownerEnvsDirs: info.envsDirs } : {}),
      ...(ownedByPrimary && condaExecutable !== undefined
        ? { ownerExecutable: condaExecutable }
        : {}),
      primaryRootTrusted: this.condaInfoPrimaryRootResolved,
    });
  }

  private toRegularPythonEnvironment(environment: CondaPrefixMetadata): PythonEnvironment {
    const version = environment.pythonVersion ?? 'no-python';
    const displayName = `${environment.name} (${version})`;
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
        ...(!supportsCondaShellActivation(environment)
          ? {}
          : condaShellCommands(environment.ownerRoot, environment.prefix)),
      },
      sysPrefix: environment.prefix,
      group:
        environment.kind === 'base' ? undefined : environment.kind === 'named' ? 'Named' : 'Prefix',
      ...(environment.pythonExists && environment.pythonVersion !== null
        ? {}
        : { error: 'Python is not installed in this conda environment' }),
    };
    return this.cachedEnvironment(info, [
      'regular',
      environment.kind,
      environment.pythonExists,
      environment.ownerRoot,
      environment.ownerExecutable,
    ]);
  }

  private async discoverWorkspaces(
    condaPlatform: string,
    condaRootPrefix: string,
    signal: AbortSignal,
  ): Promise<WorkspaceDiscovery> {
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
      if (signal.aborted) {
        break;
      }
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
        const discovery = await this.workspaces.discoverWorkspace(candidate.fsPath, condaPlatform, {
          signal,
        });
        const info = discovery.info;
        const manifestUri = Uri.file(info.manifest);
        const projectUri = this.exactPythonProject(Uri.file(path.dirname(info.manifest)));
        if (projectUri === undefined) {
          continue;
        }
        const converted = discovery.environments.map((environment) => ({
          source: environment,
          item: this.toWorkspacePythonEnvironment(
            environment,
            projectUri,
            manifestUri,
            info,
            condaRootPrefix,
          ),
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
                canonicalEnvironmentPath(candidate.environmentPath.fsPath) ===
                  canonicalEnvironmentPath(failure.prefix)) ||
              candidate.name === failure.environmentName,
          );
          return environment === undefined ? [] : [environment];
        });
        const environments = this.mergeEnvironments(
          retained,
          converted.map(({ item }) => item),
        );
        const detailsByPrefix = new Map<string, InstalledWorkspaceEnvironment>();
        for (const environment of environments) {
          const prefixKey = canonicalEnvironmentPath(environment.environmentPath.fsPath);
          const current = converted.find(
            ({ item }) => canonicalEnvironmentPath(item.environmentPath.fsPath) === prefixKey,
          )?.source;
          const details = current ?? previous?.detailsByPrefix.get(prefixKey);
          if (details !== undefined) {
            detailsByPrefix.set(prefixKey, details);
          }
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
          snapshotAvailable: discovery.snapshotAvailable,
          declaredEnvironments: discovery.declaredEnvironments,
          environments,
          detailsByPrefix,
          environmentFailures: discovery.failures,
        });
      } catch (error) {
        if (signal.aborted) {
          break;
        }
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
    condaRootPrefix: string,
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
        ...condaShellCommands(condaRootPrefix, prefix),
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
      condaRootPrefix,
    ]);
  }

  private cachedEnvironment(
    info: PythonEnvironmentInfo,
    fingerprintParts: readonly unknown[],
  ): PythonEnvironment {
    const prefix = canonicalEnvironmentPath(info.environmentPath.fsPath);
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
    const declared = entry.declaredEnvironments;
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
        ...(entry.snapshotAvailable
          ? { environment: selected.name }
          : { feature: dependencyFeature(selected.name, selected.features) }),
        noInstall: true,
      });
    }
    await this.workspaces.installEnvironment(entry.manifestUri.fsPath, selected.name);
    await this.refresh(entry.projectUri);
    return this.findEnvironment(selected.name, entry.manifestUri.fsPath, entry.projectUri);
  }

  private async quickCreateWorkspacePackages(
    entry: DiscoveredWorkspace,
    environment: WorkspaceEnvironmentDeclaration,
    additionalPackages: readonly string[],
  ): Promise<readonly string[]> {
    const condaDependencies =
      environment.condaDependencies ??
      Object.keys(
        (await this.workspaces.getEnvironmentInfo(entry.manifestUri.fsPath, environment.name))
          .condaDependencies,
      );
    return containsPythonSpec(condaDependencies)
      ? additionalPackages
      : environmentSpecs({ quickCreate: true, additionalPackages: [...additionalPackages] });
  }

  private async selectDeclaredEnvironment(
    candidates: readonly WorkspaceEnvironmentDeclaration[],
    quickCreate: boolean | undefined,
  ): Promise<WorkspaceEnvironmentDeclaration | undefined> {
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

  private async selectCreateChoice(
    quickCreate: boolean | undefined,
    canCreateWorkspace: boolean,
    projectUri: Uri,
    definitionFiles: readonly Uri[],
  ): Promise<CreateChoice | undefined> {
    if (quickCreate === true) {
      if (definitionFiles.length > 1) {
        throw new Error(
          `Multiple project environment definitions found in ${projectUri.fsPath}: ` +
            `${definitionFiles.map((file) => path.basename(file.fsPath)).join(', ')}. ` +
            'Use interactive creation to choose one',
        );
      }
      const definitionFile = definitionFiles[0];
      return definitionFile === undefined
        ? { kind: 'workspace' }
        : { kind: 'definition-file', definitionFile };
    }
    const choices: {
      readonly label: string;
      readonly description: string;
      readonly choice: CreateChoice;
    }[] = [];
    for (const definitionFile of definitionFiles) {
      const name = path.basename(definitionFile.fsPath);
      choices.push({
        label: name,
        description: 'Create a regular named conda environment from this file',
        choice: { kind: 'definition-file', definitionFile },
      });
    }
    if (canCreateWorkspace) {
      choices.push({
        label: 'Conda workspace',
        description: 'Create conda.toml and a managed project environment',
        choice: { kind: 'workspace' },
      });
    }
    choices.push(
      {
        label: 'Project prefix',
        description: 'Create a regular conda environment at .conda',
        choice: { kind: 'prefix' },
      },
      {
        label: 'Named environment',
        description: 'Create a regular named conda environment',
        choice: { kind: 'named' },
      },
    );
    const selected = await window.showQuickPick(choices, {
      placeHolder: 'Choose how Conda Code should create the environment',
    });
    return selected?.choice;
  }

  private async findProjectDefinitionFiles(projectUri: Uri): Promise<Uri[]> {
    const files: Uri[] = [];
    for (const name of PROJECT_ENVIRONMENT_FILE_NAMES) {
      const candidate = Uri.file(path.join(projectUri.fsPath, name));
      if (await pathExists(candidate.fsPath)) {
        files.push(candidate);
      }
    }
    return files;
  }

  private async createFromProjectDefinition(
    projectUri: Uri,
    definitionFile: Uri,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const additionalPackages = (options.additionalPackages ?? []).filter(
      (spec) => spec.trim() !== '',
    );
    const filename = path.basename(definitionFile.fsPath).toLowerCase();
    if (PROJECT_LOCK_FILE_NAMES.has(filename) && additionalPackages.length > 0) {
      throw new Error(`Additional packages would change the environment locked by ${filename}`);
    }
    const name = await this.selectNamedEnvironmentName(projectUri, options.quickCreate === true);
    if (name === undefined) {
      return undefined;
    }
    const createdPrefix = await this.conda.createEnvironmentFromFile(definitionFile.fsPath, name, {
      noDefaultPackages: PROJECT_LOCK_FILE_NAMES.has(filename),
    });
    this.additionalRegularPrefixes.add(createdPrefix);
    this.invalidateRegularDiscovery();
    await this.refresh(projectUri);
    const created = this.getEnvironmentForPrefix(createdPrefix);
    if (created === undefined) {
      throw new Error(`conda created ${name}, but Conda Code could not find it after refreshing`);
    }
    if (additionalPackages.length > 0) {
      await this.conda.installPackages(created.environmentPath.fsPath, additionalPackages);
      this.invalidateRegularDiscovery();
      await this.refresh(projectUri);
    }
    return this.getEnvironmentForPrefix(created.environmentPath.fsPath) ?? created;
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
      throw new Error(`A file or directory already exists at ${prefix}`);
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
    this.additionalRegularPrefixes.add(createdPrefix);
    this.invalidateRegularDiscovery();
    await this.refresh(projectUri);
    return this.getEnvironmentForPrefix(createdPrefix);
  }

  private async createNamedEnvironment(
    projectUri: Uri | undefined,
    options: CreateEnvironmentOptions,
  ): Promise<PythonEnvironment | undefined> {
    const name = await this.selectNamedEnvironmentName(projectUri, options.quickCreate === true);
    if (name === undefined) {
      return undefined;
    }
    const prefix = await this.conda.createNamedEnvironment(name, environmentSpecs(options));
    this.additionalRegularPrefixes.add(prefix);
    this.invalidateRegularDiscovery();
    await this.refresh(projectUri);
    return this.getEnvironmentForPrefix(prefix);
  }

  private async selectNamedEnvironmentName(
    projectUri: Uri | undefined,
    quickCreate: boolean,
  ): Promise<string | undefined> {
    const suggested = (projectUri === undefined ? 'conda-env' : path.basename(projectUri.fsPath))
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const fallback = suggested || 'conda-env';
    const name = quickCreate
      ? this.availableNamedEnvironmentName(fallback)
      : await window.showInputBox({
          title: 'Create named conda environment',
          prompt: 'Environment name',
          value: fallback,
          validateInput: (value) => {
            const normalized = value.trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
              return 'Use letters, numbers, dots, underscores, and hyphens';
            }
            if (['base', 'root'].includes(normalized.toLowerCase())) {
              return `The name ${normalized} is reserved`;
            }
            return this.namedEnvironmentNameUsed(normalized)
              ? `A named conda environment called ${normalized} already exists`
              : undefined;
          },
        });
    return name?.trim();
  }

  private availableNamedEnvironmentName(suggested: string): string {
    if (!this.namedEnvironmentNameUsed(suggested)) {
      return suggested;
    }
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${suggested}-${suffix}`;
      if (!this.namedEnvironmentNameUsed(candidate)) {
        return candidate;
      }
    }
  }

  private namedEnvironmentNameUsed(name: string): boolean {
    return this.getNamedEnvironment(name) !== undefined;
  }

  private getNamedEnvironment(name: string): PythonEnvironment | undefined {
    const primaryRoot =
      this.condaInfo === undefined || !this.condaInfoPrimaryRootResolved
        ? undefined
        : canonicalEnvironmentPath(this.condaInfo.rootPrefix);
    return this.regularEnvironments.find((environment) => {
      const metadata = this.regularMetadataByPrefix.get(
        canonicalEnvironmentPath(environment.environmentPath.fsPath),
      );
      return (
        metadata?.kind === 'named' &&
        metadata.ownerRoot !== undefined &&
        canonicalEnvironmentPath(metadata.ownerRoot) === primaryRoot &&
        environment.name.toLowerCase() === name.toLowerCase()
      );
    });
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
    const prefixKey = canonicalEnvironmentPath(prefix);
    const metadata = this.regularMetadataByPrefix.get(prefixKey);
    if (
      metadata === undefined ||
      metadata.condaInstallation ||
      metadata.ownerExecutable === undefined
    ) {
      return false;
    }
    const kind = metadata.kind;
    if (kind === 'named') {
      return (
        metadata.ownerEnvsDir !== undefined &&
        (await isRemovableCondaPrefix(prefix, metadata.ownerEnvsDir))
      );
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
        byPrefix.set(canonicalEnvironmentPath(environment.environmentPath.fsPath), environment);
      }
    }
    return [...byPrefix.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  public getEnvironmentForPrefix(prefix: string): PythonEnvironment | undefined {
    const expected = canonicalEnvironmentPath(prefix);
    return this.allEnvironments().find(
      (environment) => canonicalEnvironmentPath(environment.environmentPath.fsPath) === expected,
    );
  }

  public getCondaExecutableForPrefix(prefix: string): string | undefined {
    return this.regularMetadataByPrefix.get(canonicalEnvironmentPath(prefix))?.ownerExecutable;
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
    const prefixKey = canonicalEnvironmentPath(prefix);
    const details = entry.detailsByPrefix.get(prefixKey);
    const directDependencies = details?.directDependencies ?? [];
    return {
      projectUri: entry.projectUri,
      manifestUri: entry.manifestUri,
      environmentName: environment.name,
      features: details?.features ?? [],
      directDependencies: entry.snapshotAvailable
        ? directDependencies
        : directDependencies.map(({ name, pypi, table }) => ({
            name,
            pypi,
            ...(table === undefined ? {} : { table }),
          })),
      packages: details?.packages ?? [],
      snapshotAvailable: entry.snapshotAvailable,
      prefix,
      pythonPath,
    };
  }

  public getEnvironmentForRoute(route: CondaWorkspaceRoute): PythonEnvironment | undefined {
    return this.workspacesByProject
      .get(uriKey(route.projectUri))
      ?.environments.find(
        (environment) =>
          canonicalEnvironmentPath(environment.environmentPath.fsPath) ===
          canonicalEnvironmentPath(route.prefix),
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
