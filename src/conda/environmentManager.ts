import { stat } from 'node:fs/promises';
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
import { CondaWorkspaceSelectionState } from './selectionState';
import {
  CondaWorkspaceRoute,
  CondaWorkspaceRouteManager,
  CondaWorkspaceRouteRegistry,
  dependencyFeature,
  normalizeEnvironmentPath,
} from './workspaceRouting';
import {
  CondaWorkspacesClient,
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
}

interface CachedPythonEnvironment {
  readonly fingerprint: string;
  readonly item: PythonEnvironment;
}

export interface CondaWorkspaceEnvironmentManagerOptions {
  readonly log?: LogOutputChannel;
}

function uriKey(uri: Uri): string {
  return uri.toString(true);
}

function isWithin(root: Uri, candidate: Uri): boolean {
  if (root.scheme !== 'file' || candidate.scheme !== 'file') {
    return false;
  }

  const relative = path.relative(
    normalizeEnvironmentPath(root.fsPath),
    normalizeEnvironmentPath(candidate.fsPath),
  );
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasPythonExecutable(environment: InstalledWorkspaceEnvironment): Promise<boolean> {
  if (environment.python === null) {
    return false;
  }

  try {
    return (await stat(environment.python.executable)).isFile();
  } catch {
    return false;
  }
}

export class CondaWorkspaceEnvironmentManager
  implements EnvironmentManager, CondaWorkspaceRouteManager, Disposable
{
  public readonly name = 'conda-workspaces';
  public readonly displayName = 'Conda Workspaces';
  public readonly description = 'Python environments declared by conda workspace manifests';
  public readonly iconPath = new ThemeIcon('symbol-folder');
  public readonly preferredPackageManagerId: string;
  public readonly log?: LogOutputChannel;

  private readonly routes = new CondaWorkspaceRouteRegistry();
  private readonly workspacesByProject = new Map<string, DiscoveredWorkspace>();
  private readonly environmentItemsByPrefix = new Map<string, CachedPythonEnvironment>();
  private readonly activeByProject = new Map<string, PythonEnvironment>();
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
    private readonly client: CondaWorkspacesClient,
    private readonly selectionState: CondaWorkspaceSelectionState,
    preferredPackageManagerId: string,
    options: CondaWorkspaceEnvironmentManagerOptions = {},
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
    if (scope === 'global') {
      return undefined;
    }
    if (Array.isArray(scope) && scope.length !== 1) {
      throw new Error(
        'Conda Workspaces can create an environment for only one Python project at a time',
      );
    }

    const scopeUri = Array.isArray(scope) ? scope[0] : scope;
    if (scopeUri === undefined) {
      return undefined;
    }
    await this.refresh(scopeUri);

    const existingProject = this.owningProject(scopeUri);
    const existingWorkspace =
      existingProject === undefined
        ? undefined
        : this.workspacesByProject.get(uriKey(existingProject));

    if (existingWorkspace !== undefined) {
      return this.installDeclaredEnvironment(existingWorkspace, options);
    }

    const projectUri = this.projectUriForQuickstart(scopeUri);
    if (projectUri === undefined || projectUri.scheme !== 'file') {
      return undefined;
    }

    const specs = [
      'python',
      ...(options.additionalPackages ?? []).filter((spec) => spec.trim() !== ''),
    ];
    const result = await this.client.quickstart(projectUri.fsPath, {
      format: 'conda',
      specs: [...new Set(specs)],
    });

    await this.refresh(projectUri);
    return this.findEnvironment(result.environment, result.manifest, projectUri);
  }

  public async remove(environment: PythonEnvironment): Promise<void> {
    const route = this.routes.getRoute(environment);
    if (route === undefined) {
      return;
    }

    await this.client.cleanEnvironment(route.manifestUri.fsPath, route.environmentName);
    await this.refresh(route.projectUri);
  }

  public refresh(scope: RefreshEnvironmentsScope): Promise<void> {
    void scope;
    const refresh = this.refreshQueue.catch(() => undefined).then(() => this.refreshAll());
    this.refreshQueue = refresh;
    return refresh;
  }

  public async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
    await this.ensureInitialized();

    if (scope === 'global') {
      return [];
    }

    if (scope === 'all') {
      return this.allEnvironments();
    }

    return this.workspacesForScope(scope)
      .flatMap((entry) => entry.environments)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  public async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
    await this.ensureInitialized();
    if (scope === undefined) {
      return;
    }

    const route = environment === undefined ? undefined : this.routes.getRoute(environment);
    if (environment !== undefined && route === undefined) {
      return;
    }
    const selectedEnvironment =
      route === undefined ? undefined : this.getEnvironmentForRoute(route);
    if (environment !== undefined && selectedEnvironment === undefined) {
      return;
    }

    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const uri of scopes) {
      const project = this.owningProject(uri);
      if (
        project === undefined ||
        (route !== undefined && uriKey(route.projectUri) !== uriKey(project))
      ) {
        continue;
      }

      const key = uriKey(project);
      const oldEnvironment = this.activeByProject.get(key);
      if (selectedEnvironment === undefined) {
        this.activeByProject.delete(key);
      } else {
        this.activeByProject.set(key, selectedEnvironment);
      }
      await this.selectionState.set(project, route?.prefix);
      this.fireSelectionChange(project, oldEnvironment, selectedEnvironment);
    }
  }

  public async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
    await this.ensureInitialized();
    if (scope === undefined) {
      return undefined;
    }

    const project = this.owningProject(scope);
    return project === undefined ? undefined : this.activeByProject.get(uriKey(project));
  }

  public async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
    await this.ensureInitialized();

    const route = this.routes.getRouteByContext(context);
    if (route !== undefined) {
      return this.getEnvironmentForRoute(route);
    }
    return undefined;
  }

  public async clearCache(): Promise<void> {
    await this.refreshQueue.catch(() => undefined);
    const environments = this.allEnvironments();
    const active = [...this.activeByProject.entries()];
    const projectUris = new Map(
      [...this.workspacesByProject.entries()].map(([key, entry]) => [key, entry.projectUri]),
    );

    this.initialization = undefined;
    this.workspacesByProject.clear();
    this.activeByProject.clear();
    this.environmentItemsByPrefix.clear();
    this.routes.clear();
    await this.selectionState.clear();

    const changes = diffEnvironments(environments, []);
    if (changes.length > 0) {
      this.onDidChangeEnvironmentsEmitter.fire(changes);
    }
    for (const [key, oldEnvironment] of active) {
      this.fireSelectionChange(projectUris.get(key), oldEnvironment, undefined);
    }
  }

  public getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routes.getRoute(environment);
  }

  public dispose(): void {
    this.onDidChangeEnvironmentEmitter.dispose();
    this.onDidChangeEnvironmentsEmitter.dispose();
    this.workspacesByProject.clear();
    this.activeByProject.clear();
    this.environmentItemsByPrefix.clear();
    this.routes.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization === undefined) {
      this.initialization = this.refresh(undefined).catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async refreshAll(): Promise<void> {
    const previousEnvironments = this.allEnvironments();
    const previousActive = new Map(this.activeByProject);
    const previousProjects = new Map(
      [...this.workspacesByProject.entries()].map(([key, entry]) => [key, entry.projectUri]),
    );
    const discovered = await this.discoverWorkspaces();
    const discoveredPrefixes = new Set(
      discovered.flatMap((entry) =>
        entry.environments.map((environment) =>
          normalizeEnvironmentPath(environment.environmentPath.fsPath),
        ),
      ),
    );
    for (const prefix of this.environmentItemsByPrefix.keys()) {
      if (!discoveredPrefixes.has(prefix)) {
        this.environmentItemsByPrefix.delete(prefix);
      }
    }

    this.workspacesByProject.clear();
    this.activeByProject.clear();
    this.routes.clear();

    for (const entry of discovered) {
      this.workspacesByProject.set(uriKey(entry.projectUri), entry);
      this.routes.replaceProject(
        entry.projectUri,
        entry.environments
          .map((environment) => this.routeFromEnvironment(entry, environment))
          .filter((route): route is CondaWorkspaceRoute => route !== undefined),
      );
    }

    const changes = diffEnvironments(previousEnvironments, this.allEnvironments());
    if (changes.length > 0) {
      this.onDidChangeEnvironmentsEmitter.fire(changes);
    }

    for (const entry of discovered) {
      const key = uriKey(entry.projectUri);
      const selectedId = await this.selectionState.get(entry.projectUri);
      const selected =
        selectedId === undefined
          ? undefined
          : entry.environments.find(
              (environment) =>
                normalizeEnvironmentPath(environment.environmentPath.fsPath) ===
                normalizeEnvironmentPath(selectedId),
            );
      if (selected !== undefined) {
        this.activeByProject.set(key, selected);
      } else if (selectedId !== undefined) {
        await this.selectionState.set(entry.projectUri, undefined);
      }
      this.fireSelectionChange(entry.projectUri, previousActive.get(key), selected);
      previousActive.delete(key);
    }

    for (const [key, oldEnvironment] of previousActive) {
      const projectUri = previousProjects.get(key);
      if (projectUri !== undefined) {
        await this.selectionState.set(projectUri, undefined);
      }
      this.fireSelectionChange(projectUri, oldEnvironment, undefined);
    }
  }

  private async discoverWorkspaces(): Promise<DiscoveredWorkspace[]> {
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
    for (const candidate of candidates) {
      const directory = normalizeEnvironmentPath(path.dirname(candidate.fsPath));
      if (directories.has(directory)) {
        continue;
      }

      try {
        const candidateProject = this.exactPythonProject(Uri.file(path.dirname(candidate.fsPath)));
        if (candidateProject === undefined) {
          this.log?.debug(
            `Ignoring manifest outside a registered Python project root: ${candidate.fsPath}`,
          );
          continue;
        }
        const info = await this.client.getWorkspaceInfo(candidate.fsPath);
        const manifestUri = Uri.file(info.manifest);
        const projectUri = this.exactPythonProject(Uri.file(path.dirname(info.manifest)));
        if (projectUri === undefined) {
          continue;
        }
        const installed = await this.client.discoverInstalledEnvironments(info.manifest);
        const converted = await Promise.all(
          installed.map(async (environment) => ({
            source: environment,
            item: await this.toPythonEnvironment(environment, projectUri, manifestUri, info),
          })),
        );
        const environments = converted
          .map(({ item }) => item)
          .filter((environment): environment is PythonEnvironment => environment !== undefined);
        const featuresByPrefix = new Map(
          converted
            .filter(
              (
                entry,
              ): entry is {
                source: InstalledWorkspaceEnvironment;
                item: PythonEnvironment;
              } => entry.item !== undefined,
            )
            .map(({ source, item }) => [
              normalizeEnvironmentPath(item.environmentPath.fsPath),
              source.features,
            ]),
        );
        const directCondaDependenciesByPrefix = new Map(
          converted
            .filter(
              (
                entry,
              ): entry is {
                source: InstalledWorkspaceEnvironment;
                item: PythonEnvironment;
              } => entry.item !== undefined,
            )
            .map(({ source, item }) => [
              normalizeEnvironmentPath(item.environmentPath.fsPath),
              Object.keys(source.condaDependencies),
            ]),
        );
        directories.add(directory);
        discovered.push({
          projectUri,
          manifestUri,
          info,
          environments,
          featuresByPrefix,
          directCondaDependenciesByPrefix,
        });
      } catch (error) {
        this.log?.debug(
          `Ignoring non-workspace manifest ${candidate.fsPath}: ${errorMessage(error)}`,
        );
      }
    }

    return discovered;
  }

  private async toPythonEnvironment(
    environment: InstalledWorkspaceEnvironment,
    projectUri: Uri,
    manifestUri: Uri,
    workspaceInfo: WorkspaceInfo,
  ): Promise<PythonEnvironment | undefined> {
    if (!(await hasPythonExecutable(environment)) || environment.python === null) {
      return undefined;
    }

    const prefix = normalizeEnvironmentPath(environment.prefix);
    const displayName = `${workspaceInfo.name}:${environment.name} (${environment.python.version})`;
    const info: PythonEnvironmentInfo = {
      name: environment.name,
      displayName,
      shortDisplayName: `${environment.name} (${environment.python.version})`,
      displayPath: prefix,
      version: environment.python.version,
      environmentPath: Uri.file(prefix),
      description: 'conda workspace',
      tooltip: manifestUri.fsPath,
      iconPath: new ThemeIcon('python'),
      execInfo: {
        run: { executable: environment.python.executable },
        activatedRun: { executable: environment.python.executable },
      },
      sysPrefix: prefix,
      group: {
        name: workspaceInfo.name,
        description: projectUri.fsPath,
      },
    };
    const fingerprint = JSON.stringify([
      info.name,
      info.displayName,
      info.version,
      info.environmentPath.fsPath,
      info.execInfo.run.executable,
      info.sysPrefix,
      workspaceInfo.name,
      projectUri.toString(true),
      manifestUri.toString(true),
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
    const declared = await this.client.listEnvironments(entry.manifestUri.fsPath);
    const candidates = declared.filter((environment) => !environment.installed);
    const selected = await this.selectDeclaredEnvironment(candidates, options.quickCreate);
    if (selected === undefined) {
      return undefined;
    }

    const additionalPackages = (options.additionalPackages ?? []).filter(
      (spec) => spec.trim() !== '',
    );
    if (additionalPackages.length > 0) {
      await this.client.addDependencies(entry.manifestUri.fsPath, additionalPackages, {
        feature: dependencyFeature(selected.name, selected.features),
        noInstall: true,
      });
    }
    await this.client.installEnvironment(entry.manifestUri.fsPath, selected.name);
    await this.refresh(entry.projectUri);
    return this.findEnvironment(selected.name, entry.manifestUri.fsPath, entry.projectUri);
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

  private projectUriForQuickstart(scope: Uri): Uri | undefined {
    return this.api.getPythonProject(scope)?.uri ?? workspace.getWorkspaceFolder(scope)?.uri;
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

  private allEnvironments(): PythonEnvironment[] {
    const byId = new Map<string, PythonEnvironment>();
    for (const entry of this.workspacesByProject.values()) {
      for (const environment of entry.environments) {
        byId.set(environment.envId.id, environment);
      }
    }
    return [...byId.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  private routeFromEnvironment(
    entry: DiscoveredWorkspace,
    environment: PythonEnvironment,
  ): CondaWorkspaceRoute | undefined {
    const pythonPath = environment.execInfo.run.executable;
    if (pythonPath === '') {
      return undefined;
    }
    const prefix = normalizeEnvironmentPath(environment.environmentPath.fsPath);
    return {
      projectUri: entry.projectUri,
      manifestUri: entry.manifestUri,
      environmentName: environment.name,
      features: entry.featuresByPrefix.get(prefix) ?? [],
      directCondaDependencies: entry.directCondaDependenciesByPrefix.get(prefix) ?? [],
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
    project: Uri | undefined,
    oldEnvironment: PythonEnvironment | undefined,
    newEnvironment: PythonEnvironment | undefined,
  ): void {
    if (oldEnvironment?.envId.id === newEnvironment?.envId.id) {
      return;
    }
    this.onDidChangeEnvironmentEmitter.fire({
      uri: project,
      old: oldEnvironment,
      new: newEnvironment,
    });
  }
}
