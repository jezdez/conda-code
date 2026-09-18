import { ProgressLocation, type QuickPickItem, Uri, window } from 'vscode';

import {
  refreshWorkspaceActionContext,
  selectWorkspaceActionContext,
  type WorkspaceActionOptions,
} from './workspaceActions';
import { normalizeEnvironmentPath } from './workspaceRouting';
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotEnvironment,
  WorkspaceSnapshotResolution,
} from './workspaces';

interface WorkspaceEnvironmentQuickPickItem extends QuickPickItem {
  readonly environment: WorkspaceSnapshotEnvironment;
}

interface WorkspacePlatformQuickPickItem extends QuickPickItem {
  readonly resolution: WorkspaceSnapshotResolution;
}

interface WorkspaceSbomModeQuickPickItem extends QuickPickItem {
  readonly reproducible: boolean;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedWorkspaceSbomMessage(error: unknown): string {
  const message = messageFromError(error);
  return /invalid choice:\s*['"]?sbom/i.test(message) ||
    /(?:unrecognized arguments|unknown option|no such option).*(?:--packages|--environment|--platform|--reproducible)/i.test(
      message,
    )
    ? 'The configured conda-workspaces does not support workspace lockfile SBOM export. ' +
        'Install conda-workspaces 0.9 or newer in the configured conda installation.'
    : message;
}

async function reportWorkspaceSbomError(
  options: WorkspaceActionOptions,
  error: unknown,
): Promise<void> {
  const message = unsupportedWorkspaceSbomMessage(error);
  options.log?.error(`Workspace lockfile SBOM export failed: ${messageFromError(error)}`);
  await window.showErrorMessage(`Could not export the workspace lockfile SBOM: ${message}`);
}

function environmentDescription(environment: WorkspaceSnapshotEnvironment): string {
  const installed = environment.installed ? 'Installed' : 'Not installed';
  return environment.features.length === 0
    ? installed
    : `${installed} · Features: ${environment.features.join(', ')}`;
}

async function selectEnvironment(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshotEnvironment | undefined> {
  if (snapshot.environments.length === 0) {
    throw new Error('The selected workspace has no environment declarations.');
  }
  const selected = await window.showQuickPick<WorkspaceEnvironmentQuickPickItem>(
    snapshot.environments.map((environment) => ({
      label: environment.name,
      description: environmentDescription(environment),
      environment,
    })),
    {
      title: 'Export a workspace lockfile SBOM',
      placeHolder: 'Choose a declared workspace environment',
      ignoreFocusOut: true,
    },
  );
  return selected?.environment;
}

async function selectPlatform(
  environment: WorkspaceSnapshotEnvironment,
): Promise<WorkspaceSnapshotResolution | undefined> {
  if (environment.resolutions.length === 0) {
    throw new Error(`The workspace lockfile has no platform resolutions for ${environment.name}.`);
  }
  const selected = await window.showQuickPick<WorkspacePlatformQuickPickItem>(
    environment.resolutions.map((resolution) => ({
      label: resolution.platform,
      description: `Conda subdir: ${resolution.subdir}`,
      resolution,
    })),
    {
      title: `Export an SBOM for ${environment.name}`,
      placeHolder: 'Choose a declared platform',
      ignoreFocusOut: true,
    },
  );
  return selected?.resolution;
}

async function selectReproducible(): Promise<boolean | undefined> {
  const selected = await window.showQuickPick<WorkspaceSbomModeQuickPickItem>(
    [
      {
        label: 'Reproducible',
        description: 'Omit the SBOM timestamp',
        reproducible: true,
      },
      {
        label: 'Timestamped',
        description: 'Include the generation timestamp',
        reproducible: false,
      },
    ],
    {
      title: 'Choose workspace SBOM output',
      placeHolder: 'Choose whether to include a generation timestamp',
      ignoreFocusOut: true,
    },
  );
  return selected?.reproducible;
}

function findCurrentSelection(
  snapshot: WorkspaceSnapshot,
  environmentName: string,
  platform: string,
): void {
  const environment = snapshot.environments.find(({ name }) => name === environmentName);
  if (environment === undefined) {
    throw new Error('The workspace environment declaration changed before export');
  }
  if (!environment.resolutions.some((resolution) => resolution.platform === platform)) {
    throw new Error('The workspace platform declaration changed before export');
  }
}

export async function exportWorkspaceLockfileSbom(options: WorkspaceActionOptions): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const snapshot = await options.workspaces.getWorkspaceSnapshot(context.manifestUri.fsPath);
    const environment = await selectEnvironment(snapshot);
    if (environment === undefined) {
      return;
    }
    const resolution = await selectPlatform(environment);
    if (resolution === undefined) {
      return;
    }
    const reproducible = await selectReproducible();
    if (reproducible === undefined) {
      return;
    }
    const destination = await window.showSaveDialog({
      defaultUri: Uri.joinPath(
        context.projectUri,
        `${environment.name}-${resolution.platform}.cdx.json`,
      ),
      filters: { 'CycloneDX JSON': ['json'] },
      saveLabel: 'Export Workspace SBOM',
      title: 'Choose the workspace SBOM destination',
    });
    if (destination === undefined) {
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Exporting ${environment.name} for ${resolution.platform} from the workspace lockfile`,
      },
      async () => {
        await refreshWorkspaceActionContext(options, context);
        const current = await options.workspaces.getWorkspaceSnapshot(context.manifestUri.fsPath);
        if (
          normalizeEnvironmentPath(current.manifest) !==
          normalizeEnvironmentPath(context.manifestUri.fsPath)
        ) {
          throw new Error('Workspace ownership changed while the action was being prepared');
        }
        findCurrentSelection(current, environment.name, resolution.platform);
        await options.workspaces.exportWorkspaceSbom(
          context.manifestUri.fsPath,
          environment.name,
          resolution.platform,
          destination.fsPath,
          { reproducible },
        );
      },
    );
    await window.showInformationMessage(
      `Exported the ${environment.name} workspace SBOM for ${resolution.platform} to ${destination.fsPath}.`,
    );
  } catch (error) {
    await reportWorkspaceSbomError(options, error);
  }
}
