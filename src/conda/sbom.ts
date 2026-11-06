import { homedir } from 'node:os';

import type { PythonEnvironmentApi } from '@vscode/python-environments';
import { LogOutputChannel, ProgressLocation, Uri, window, workspace } from 'vscode';

import { CondaClient } from './conda';
import type { CondaWorkspaceRouteManager } from './workspaceRouting';

export interface ExportSelectedEnvironmentSbomOptions {
  readonly api: PythonEnvironmentApi;
  readonly conda: CondaClient;
  readonly environments: CondaWorkspaceRouteManager;
  readonly log?: LogOutputChannel;
  readonly managerId: string;
  readonly scope?: Uri;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function exportSelectedEnvironmentSbom(
  options: ExportSelectedEnvironmentSbomOptions,
): Promise<void> {
  const { api, conda, environments, log, managerId, scope } = options;
  try {
    const selected = await api.getEnvironment(scope);
    if (selected === undefined || selected.envId.managerId !== managerId) {
      await window.showErrorMessage('Select a Conda Code environment for the active scope first.');
      return;
    }

    const prefix = selected.environmentPath.fsPath;
    const executable =
      environments.getRoute(selected) === undefined
        ? environments.getCondaExecutableForPrefix(prefix)
        : conda.executable;
    if (executable === undefined) {
      await window.showErrorMessage(
        `Conda Code does not know which conda installation owns ${prefix}.`,
      );
      return;
    }

    const directory =
      (scope === undefined ? undefined : workspace.getWorkspaceFolder(scope)?.uri) ??
      workspace.workspaceFolders?.[0]?.uri ??
      Uri.file(homedir());
    const destination = await window.showSaveDialog({
      defaultUri: Uri.joinPath(directory, `${selected.name}.cdx.json`),
      filters: { 'CycloneDX JSON': ['json'] },
      saveLabel: 'Export SBOM',
    });
    if (destination === undefined) {
      return;
    }
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Exporting an SBOM for ${selected.displayName}`,
      },
      () => conda.forExecutable(executable).exportEnvironmentSbom(prefix, destination.fsPath),
    );
    await window.showInformationMessage(
      `Exported an SBOM for ${selected.displayName} to ${destination.fsPath}.`,
    );
  } catch (error) {
    const message = messageFromError(error);
    log?.error(`SBOM export failed: ${message}`);
    await window.showErrorMessage(`Could not export the environment SBOM: ${message}`);
  }
}
