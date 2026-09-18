import { ProgressLocation, type QuickPickItem, window } from 'vscode';

import {
  refreshWorkspaceActionContext,
  selectWorkspaceActionContext,
  selectInstalledWorkspaceEnvironment,
  type WorkspaceActionOptions,
} from './workspaceActions';
import type { WorkspaceInfo, WorkspaceLockfileStatus } from './workspaces';

const CONDA_WORKSPACES_010_MESSAGE =
  'Install conda-workspaces 0.10 or newer in the configured conda installation.';
const UNSUPPORTED_LOCK_ACTION_MESSAGE =
  'The configured conda-workspaces does not support workspace lock actions. ' +
  CONDA_WORKSPACES_010_MESSAGE;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedLockActionMessage(error: unknown): string {
  const message = messageFromError(error);
  return /invalid choice:\s*['"]?lock/i.test(message) ||
    /(?:unrecognized arguments|unknown option|no such option).*--locked/i.test(message)
    ? UNSUPPORTED_LOCK_ACTION_MESSAGE
    : message;
}

async function reportLockActionError(
  options: WorkspaceActionOptions,
  operation: 'read' | 'update' | 'install from',
  error: unknown,
): Promise<void> {
  const message = unsupportedLockActionMessage(error);
  options.log?.error(`Workspace lockfile ${operation} failed: ${messageFromError(error)}`);
  await window.showErrorMessage(`Could not ${operation} the workspace lockfile: ${message}`);
}

function statusLabel(status: WorkspaceLockfileStatus): string {
  switch (status) {
    case 'up-to-date':
      return 'current';
    case 'out-of-date':
      return 'stale';
    case 'missing':
      return 'missing';
  }
}

function statusMessage(info: WorkspaceInfo): string {
  if (info.lockfileStatus === undefined) {
    throw new Error(
      'The configured conda-workspaces does not report workspace lockfile status. ' +
        CONDA_WORKSPACES_010_MESSAGE,
    );
  }
  const reportedReason = info.lockfileReason?.trim();
  const reason = reportedReason ? `: ${reportedReason}` : '';
  return `Workspace lockfile is ${statusLabel(info.lockfileStatus)}${reason}.`;
}

function requireCurrentLockfile(info: WorkspaceInfo): void {
  if (info.lockfileStatus === 'up-to-date') {
    return;
  }
  if (info.lockfileStatus === undefined) {
    throw new Error(
      'The configured conda-workspaces does not report workspace lockfile status. ' +
        CONDA_WORKSPACES_010_MESSAGE,
    );
  }
  throw new Error(statusMessage(info));
}

export async function showWorkspaceLockStatus(options: WorkspaceActionOptions): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const info = await refreshWorkspaceActionContext(options, context);
    await window.showInformationMessage(statusMessage(info));
  } catch (error) {
    await reportLockActionError(options, 'read', error);
  }
}

export async function updateWorkspaceLockfile(options: WorkspaceActionOptions): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'Updating workspace lockfile',
      },
      async () => {
        await refreshWorkspaceActionContext(options, context);
        await options.workspaces.updateLockfile(context.manifestUri.fsPath);
        await options.environments.refresh(context.projectUri);
      },
    );
    await window.showInformationMessage('Updated the workspace lockfile.');
  } catch (error) {
    await reportLockActionError(options, 'update', error);
  }
}

function environmentDescription(environment: {
  readonly installed: boolean;
  readonly features: readonly string[];
}): string {
  const installed = environment.installed ? 'Installed' : 'Not installed';
  return environment.features.length === 0
    ? installed
    : `${installed} · Features: ${environment.features.join(', ')}`;
}

export async function installLockedWorkspaceEnvironment(
  options: WorkspaceActionOptions,
): Promise<void> {
  try {
    const context = await selectWorkspaceActionContext(options);
    if (context === undefined) {
      return;
    }
    const declarations = await options.workspaces.listEnvironments(context.manifestUri.fsPath);
    if (declarations.length === 0) {
      await window.showErrorMessage('The selected workspace has no environment declarations.');
      return;
    }
    const selectedItem = await window.showQuickPick<QuickPickItem>(
      declarations.map((environment) => ({
        label: environment.name,
        description: environmentDescription(environment),
      })),
      {
        title: 'Install from the workspace lockfile',
        placeHolder: 'Choose the workspace environment to install',
        ignoreFocusOut: true,
      },
    );
    if (selectedItem === undefined) {
      return;
    }
    const selected = declarations.find(({ name }) => name === selectedItem.label);
    if (selected === undefined) {
      throw new Error('The selected workspace environment declaration is no longer available');
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Installing ${selected.name} from the workspace lockfile`,
      },
      async () => {
        const info = await refreshWorkspaceActionContext(options, context);
        requireCurrentLockfile(info);
        const current = await options.workspaces.listEnvironments(context.manifestUri.fsPath);
        if (!current.some(({ name }) => name === selected.name)) {
          throw new Error('The workspace environment declaration changed before installation');
        }
        await options.workspaces.installLockedEnvironment(
          context.manifestUri.fsPath,
          selected.name,
        );
        await options.environments.refresh(context.projectUri);
        await selectInstalledWorkspaceEnvironment(options, context, selected.name);
      },
    );
    await window.showInformationMessage(
      `Installed workspace environment ${selected.name} from the lockfile.`,
    );
  } catch (error) {
    await reportLockActionError(options, 'install from', error);
  }
}
