import path from 'node:path';

import type { PythonEnvironment, PythonEnvironmentApi } from '@vscode/python-environments';
import {
  type LogOutputChannel,
  ProgressLocation,
  type QuickPickItem,
  type Uri,
  window,
} from 'vscode';

import type { CondaWorkspaceRoute } from './workspaceRouting';
import { normalizeEnvironmentPath } from './workspaceRouting';
import type {
  AddWorkspaceEnvironmentOptions,
  CondaWorkspacesClient,
  WorkspaceEnvironment,
  WorkspaceInfo,
} from './workspaces';

export interface WorkspaceActionContext {
  readonly projectUri: Uri;
  readonly manifestUri: Uri;
}

export interface WorkspaceActionEnvironmentManager {
  getWorkspaceManifests(): Promise<Uri[]>;
  refresh(scope: Uri): Promise<void>;
  getEnvironments(scope: Uri): Promise<PythonEnvironment[]>;
  getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined;
  set(scope: Uri, environment?: PythonEnvironment): Promise<void>;
}

export interface WorkspaceActionContextOptions {
  readonly api: Pick<PythonEnvironmentApi, 'getPythonProject'>;
  readonly environments: WorkspaceActionEnvironmentManager;
  readonly scope?: Uri;
}

export interface WorkspaceActionOptions extends WorkspaceActionContextOptions {
  readonly workspaces: CondaWorkspacesClient;
  readonly log?: LogOutputChannel;
}

interface WorkspaceContextQuickPickItem extends QuickPickItem {
  readonly context: WorkspaceActionContext;
}

interface WorkspaceFeatureQuickPickItem extends QuickPickItem {
  readonly feature?: string;
  readonly defaultFeature: boolean;
}

interface WorkspaceEnvironmentQuickPickItem extends QuickPickItem {
  readonly environment: WorkspaceEnvironment;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameUri(left: Uri, right: Uri): boolean {
  return normalizeEnvironmentPath(left.fsPath) === normalizeEnvironmentPath(right.fsPath);
}

async function workspaceActionContexts(
  options: WorkspaceActionContextOptions,
): Promise<WorkspaceActionContext[]> {
  const manifests = await options.environments.getWorkspaceManifests();
  return manifests
    .flatMap((manifestUri) => {
      const projectUri = options.api.getPythonProject(manifestUri)?.uri;
      if (
        manifestUri.scheme !== 'file' ||
        projectUri?.scheme !== 'file' ||
        normalizeEnvironmentPath(path.dirname(manifestUri.fsPath)) !==
          normalizeEnvironmentPath(projectUri.fsPath)
      ) {
        return [];
      }
      return [{ projectUri, manifestUri }];
    })
    .sort((left, right) => left.projectUri.fsPath.localeCompare(right.projectUri.fsPath));
}

export async function selectWorkspaceActionContext(
  options: WorkspaceActionContextOptions,
): Promise<WorkspaceActionContext | undefined> {
  const contexts = await workspaceActionContexts(options);
  if (contexts.length === 0) {
    await window.showErrorMessage(
      'No Conda Code workspace is available. Register a workspace as a Python project first.',
    );
    return undefined;
  }

  const scopeProject =
    options.scope?.scheme === 'file' ? options.api.getPythonProject(options.scope)?.uri : undefined;
  const scoped = contexts.filter(
    ({ manifestUri, projectUri }) =>
      (options.scope !== undefined && sameUri(manifestUri, options.scope)) ||
      (scopeProject !== undefined && sameUri(projectUri, scopeProject)),
  );
  const candidates = scoped.length > 0 ? scoped : contexts;
  if (candidates.length === 1) {
    return candidates[0];
  }

  const selected = await window.showQuickPick<WorkspaceContextQuickPickItem>(
    candidates.map((context) => ({
      label: path.basename(context.projectUri.fsPath),
      description: context.manifestUri.fsPath,
      context,
    })),
    {
      title: 'Select a conda workspace',
      placeHolder: 'Choose the workspace declaration to change',
      ignoreFocusOut: true,
    },
  );
  return selected?.context;
}

export async function refreshWorkspaceActionContext(
  options: WorkspaceActionOptions,
  context: WorkspaceActionContext,
): Promise<WorkspaceInfo> {
  await options.environments.refresh(context.projectUri);
  const contexts = await workspaceActionContexts(options);
  const current = contexts.find(
    (candidate) =>
      sameUri(candidate.projectUri, context.projectUri) &&
      sameUri(candidate.manifestUri, context.manifestUri),
  );
  if (current === undefined) {
    throw new Error('Workspace ownership changed while the action was being prepared');
  }

  const info = await options.workspaces.getWorkspaceInfo(context.manifestUri.fsPath);
  if (
    normalizeEnvironmentPath(info.manifest) !== normalizeEnvironmentPath(context.manifestUri.fsPath)
  ) {
    throw new Error('Workspace ownership changed while the action was being prepared');
  }
  return info;
}

export async function selectInstalledWorkspaceEnvironment(
  options: WorkspaceActionOptions,
  context: WorkspaceActionContext,
  environmentName: string,
): Promise<void> {
  const environments = await options.environments.getEnvironments(context.projectUri);
  const environment = environments.find((candidate) => {
    const route = options.environments.getRoute(candidate);
    return (
      candidate.name === environmentName &&
      route !== undefined &&
      route.environmentName === environmentName &&
      sameUri(route.projectUri, context.projectUri) &&
      sameUri(route.manifestUri, context.manifestUri)
    );
  });
  if (environment !== undefined) {
    await options.environments.set(context.projectUri, environment);
  }
}

function unsupportedLifecycleMessage(
  operation: 'create' | 'import' | 'remove',
  error: unknown,
): string {
  const message = messageFromError(error);
  const unsupported =
    /invalid choice:\s*['"]?(?:add|import|remove)/i.test(message) ||
    /(?:unrecognized arguments|unknown option|no such option).*(?:--with-feature|--no-default-feature|--all)/i.test(
      message,
    ) ||
    (operation === 'import' &&
      /(?:unrecognized arguments|unknown option|no such option).*(?:-e|--environment)/i.test(
        message,
      )) ||
    (operation === 'create' &&
      /(?:at least one|one or more).*(?:package|spec)|(?:package|spec).*(?:required|missing)/i.test(
        message,
      ));
  return unsupported
    ? `The configured conda-workspaces does not support workspace environment ${operation}. ` +
        'Install conda-workspaces 0.9 or newer in the configured conda installation.'
    : message;
}

async function reportWorkspaceActionError(
  options: WorkspaceActionOptions,
  operation: 'create' | 'import' | 'remove',
  error: unknown,
): Promise<void> {
  const message = unsupportedLifecycleMessage(operation, error);
  options.log?.error(`Workspace environment ${operation} failed: ${messageFromError(error)}`);
  await window.showErrorMessage(`Could not ${operation} the workspace environment: ${message}`);
}

async function inputEnvironmentName(title: string): Promise<string | undefined> {
  const value = await window.showInputBox({
    title,
    prompt: 'Enter the workspace environment name',
    placeHolder: 'analysis',
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim() === '' ? 'Enter a workspace environment name' : undefined,
  });
  const name = value?.trim();
  return name === '' ? undefined : name;
}

async function selectWorkspaceFeatures(
  info: WorkspaceInfo,
): Promise<AddWorkspaceEnvironmentOptions | undefined> {
  const items: WorkspaceFeatureQuickPickItem[] = [
    {
      label: 'Default feature',
      description: 'Include dependencies shared by every default environment',
      picked: true,
      defaultFeature: true,
    },
    ...(info.features ?? [])
      .filter((feature) => feature.toLowerCase() !== 'default')
      .map((feature) => ({
        label: feature,
        description: 'Workspace feature',
        defaultFeature: false,
        feature,
      })),
  ];
  const selected = await window.showQuickPick(items, {
    title: 'Select workspace features',
    placeHolder: 'Keep the default feature or compose named features',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (selected === undefined) {
    return undefined;
  }
  return {
    features: selected.flatMap(({ feature }) => (feature === undefined ? [] : [feature])),
    noDefaultFeature: !selected.some(({ defaultFeature }) => defaultFeature),
  };
}

export async function createWorkspaceEnvironment(options: WorkspaceActionOptions): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const info = await options.workspaces.getWorkspaceInfo(context.manifestUri.fsPath);
    const environmentName = await inputEnvironmentName('Create a workspace environment');
    if (environmentName === undefined) {
      return;
    }
    const featureOptions = await selectWorkspaceFeatures(info);
    if (featureOptions === undefined) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Creating workspace environment ${environmentName}`,
      },
      async () => {
        const currentInfo = await refreshWorkspaceActionContext(options, context);
        const currentFeatures = new Set(currentInfo.features ?? []);
        if (featureOptions.features?.some((feature) => !currentFeatures.has(feature)) === true) {
          throw new Error('Workspace features changed while the action was being prepared');
        }
        await options.workspaces.addEnvironment(
          context.manifestUri.fsPath,
          environmentName,
          featureOptions,
        );
        await options.environments.refresh(context.projectUri);
        await selectInstalledWorkspaceEnvironment(options, context, environmentName);
      },
    );
    await window.showInformationMessage(`Created workspace environment ${environmentName}.`);
  } catch (error) {
    await reportWorkspaceActionError(options, 'create', error);
  }
}

function supportedImportFile(definition: Uri): boolean {
  return (
    definition.scheme === 'file' &&
    ['environment.yml', 'environment.yaml'].includes(path.basename(definition.fsPath).toLowerCase())
  );
}

export async function importWorkspaceEnvironment(
  options: WorkspaceActionOptions,
  definition?: Uri,
): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const selectedDefinition =
      definition ??
      (
        await window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'Conda environment file': ['yml', 'yaml'] },
          openLabel: 'Import into Workspace',
          title: 'Select environment.yml to import',
        })
      )?.[0];
    if (selectedDefinition === undefined) {
      return;
    }
    if (!supportedImportFile(selectedDefinition)) {
      throw new Error('Workspace import accepts only environment.yml or environment.yaml');
    }
    const environmentName = await inputEnvironmentName('Import a workspace environment');
    if (environmentName === undefined) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Importing workspace environment ${environmentName}`,
      },
      async () => {
        await refreshWorkspaceActionContext(options, context);
        await options.workspaces.importEnvironment(
          context.manifestUri.fsPath,
          environmentName,
          selectedDefinition.fsPath,
        );
        await options.environments.refresh(context.projectUri);
        await selectInstalledWorkspaceEnvironment(options, context, environmentName);
      },
    );
    await window.showInformationMessage(`Imported workspace environment ${environmentName}.`);
  } catch (error) {
    await reportWorkspaceActionError(options, 'import', error);
  }
}

async function selectDeclaredEnvironment(
  environments: readonly WorkspaceEnvironment[],
): Promise<WorkspaceEnvironment | undefined> {
  if (environments.length === 0) {
    await window.showErrorMessage('The selected workspace has no environment declarations.');
    return undefined;
  }
  if (environments.length === 1) {
    return environments[0];
  }
  const selected = await window.showQuickPick<WorkspaceEnvironmentQuickPickItem>(
    environments.map((environment) => ({
      label: environment.name,
      description: environment.installed ? 'Installed' : 'Not installed',
      detail:
        environment.features.length === 0
          ? 'No named features'
          : `Features: ${environment.features.join(', ')}`,
      environment,
    })),
    {
      title: 'Remove a workspace environment declaration',
      placeHolder: 'Choose the declaration to remove',
      ignoreFocusOut: true,
    },
  );
  return selected?.environment;
}

export async function removeWorkspaceEnvironment(options: WorkspaceActionOptions): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const selected = await selectDeclaredEnvironment(
      await options.workspaces.listEnvironments(context.manifestUri.fsPath),
    );
    if (selected === undefined) {
      return;
    }
    const confirmation = await window.showWarningMessage(
      `Remove the ${selected.name} declaration, lock records, and installed prefix?`,
      { modal: true },
      'Remove Declaration',
    );
    if (confirmation !== 'Remove Declaration') {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Removing workspace environment ${selected.name}`,
      },
      async () => {
        await refreshWorkspaceActionContext(options, context);
        const current = await options.workspaces.listEnvironments(context.manifestUri.fsPath);
        if (!current.some(({ name }) => name === selected.name)) {
          throw new Error('The workspace environment declaration changed before removal');
        }
        await options.workspaces.removeEnvironmentDeclaration(
          context.manifestUri.fsPath,
          selected.name,
        );
        await options.environments.refresh(context.projectUri);
      },
    );
    await window.showInformationMessage(`Removed workspace environment ${selected.name}.`);
  } catch (error) {
    await reportWorkspaceActionError(options, 'remove', error);
  }
}
