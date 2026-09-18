import { type QuickPickItem, tasks as vscodeTasks, Uri, window, workspace } from 'vscode';

import { createWorkspaceImageTask } from './tasks';
import {
  refreshWorkspaceActionContext,
  selectWorkspaceActionContext,
  type WorkspaceActionContext,
  type WorkspaceActionOptions,
} from './workspaceActions';
import type {
  WorkspaceImageDestination,
  WorkspaceSnapshot,
  WorkspaceSnapshotEnvironment,
  WorkspaceSnapshotResolution,
} from './workspaces';

interface EnvironmentQuickPickItem extends QuickPickItem {
  readonly environment: WorkspaceSnapshotEnvironment;
}

interface PlatformQuickPickItem extends QuickPickItem {
  readonly resolution: WorkspaceSnapshotResolution;
}

interface DestinationQuickPickItem extends QuickPickItem {
  readonly destination: 'load' | 'output';
}

interface WorkspaceImageSelection {
  readonly context: WorkspaceActionContext;
  readonly environment: WorkspaceSnapshotEnvironment;
  readonly resolution: WorkspaceSnapshotResolution;
  readonly tag: string;
  readonly command: readonly string[];
}

const LINUX_SUBDIRS = new Set(['linux-64', 'linux-aarch64']);

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedImageMessage(error: unknown): string {
  const message = messageFromError(error);
  return /invalid choice:\s*['"]?image|(?:unrecognized arguments|unknown option|no such option).*(?:image|--packages)/i.test(
    message,
  )
    ? 'The configured conda-workspaces does not support workspace images. Install conda-workspaces 0.10 or newer in the configured conda installation.'
    : message;
}

async function reportError(options: WorkspaceActionOptions, error: unknown): Promise<void> {
  const message = unsupportedImageMessage(error);
  options.log?.error(`Workspace image action failed: ${message}`);
  await window.showErrorMessage(`Could not prepare the workspace image: ${message}`);
}

function environmentDescription(environment: WorkspaceSnapshotEnvironment): string {
  const installation = environment.installed ? 'Installed' : 'Not installed';
  return environment.features.length === 0
    ? installation
    : `${installation} · Features: ${environment.features.join(', ')}`;
}

async function selectEnvironment(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshotEnvironment | undefined> {
  if (snapshot.environments.length === 0) {
    throw new Error('The workspace declares no environments to build into an image.');
  }
  const selected = await window.showQuickPick<EnvironmentQuickPickItem>(
    snapshot.environments.map((environment) => ({
      label: environment.name,
      description: environmentDescription(environment),
      environment,
    })),
    {
      title: 'Select a workspace image environment',
      placeHolder: 'Choose a declared environment',
      ignoreFocusOut: true,
    },
  );
  return selected?.environment;
}

async function selectPlatform(
  environment: WorkspaceSnapshotEnvironment,
): Promise<WorkspaceSnapshotResolution | undefined> {
  const resolutions = environment.resolutions.filter(({ subdir }) => LINUX_SUBDIRS.has(subdir));
  if (resolutions.length === 0) {
    throw new Error(
      `${environment.name} has no image-compatible linux-64 or linux-aarch64 resolution.`,
    );
  }
  const selected = await window.showQuickPick<PlatformQuickPickItem>(
    resolutions.map((resolution) => ({
      label: resolution.platform,
      description: `Conda subdir: ${resolution.subdir}`,
      resolution,
    })),
    {
      title: 'Select a workspace image platform',
      placeHolder: 'Choose a declared Linux platform',
      ignoreFocusOut: true,
    },
  );
  return selected?.resolution;
}

function validateArguments(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((argument) => typeof argument === 'string')) {
      return 'Enter a JSON array containing only strings.';
    }
  } catch {
    return 'Enter a valid JSON array of strings.';
  }
  return undefined;
}

function parseArguments(value: string): readonly string[] {
  const validation = validateArguments(value);
  if (validation !== undefined) {
    throw new Error(validation);
  }
  return JSON.parse(value) as string[];
}

async function selectImage(
  options: WorkspaceActionOptions,
): Promise<WorkspaceImageSelection | undefined> {
  const context = await selectWorkspaceActionContext(options);
  if (context === undefined) {
    return undefined;
  }
  const snapshot = await options.workspaces.getWorkspaceSnapshot(context.manifestUri.fsPath);
  const environment = await selectEnvironment(snapshot);
  if (environment === undefined) {
    return undefined;
  }
  const resolution = await selectPlatform(environment);
  if (resolution === undefined) {
    return undefined;
  }
  const tag = await window.showInputBox({
    title: 'Workspace image tag',
    prompt: 'Enter the local or archive image tag',
    value: `${snapshot.name}:latest`,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'Enter an image tag.' : undefined),
  });
  if (tag === undefined) {
    return undefined;
  }
  const executable = await window.showInputBox({
    title: 'Workspace image command',
    prompt: 'Enter the default command executable',
    value: 'python',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'Enter a command executable.' : undefined),
  });
  if (executable === undefined) {
    return undefined;
  }
  const argumentsJson = await window.showInputBox({
    title: 'Workspace image command arguments',
    prompt: 'Enter a JSON array of separate command arguments',
    value: '[]',
    ignoreFocusOut: true,
    validateInput: validateArguments,
  });
  if (argumentsJson === undefined) {
    return undefined;
  }
  return {
    context,
    environment,
    resolution,
    tag: tag.trim(),
    command: [executable.trim(), ...parseArguments(argumentsJson)],
  };
}

async function revalidateSelection(
  options: WorkspaceActionOptions,
  selection: WorkspaceImageSelection,
): Promise<void> {
  await refreshWorkspaceActionContext(options, selection.context);
  const snapshot = await options.workspaces.getWorkspaceSnapshot(
    selection.context.manifestUri.fsPath,
  );
  const environment = snapshot.environments.find(
    (candidate) => candidate.name === selection.environment.name,
  );
  const resolution = environment?.resolutions.find(
    (candidate) =>
      candidate.platform === selection.resolution.platform &&
      candidate.subdir === selection.resolution.subdir &&
      LINUX_SUBDIRS.has(candidate.subdir),
  );
  if (resolution === undefined) {
    throw new Error('The workspace image environment or platform changed before the action ran.');
  }
}

async function preview(
  options: WorkspaceActionOptions,
  selection: WorkspaceImageSelection,
  destination: WorkspaceImageDestination,
) {
  return options.workspaces.previewWorkspaceImage(
    selection.context.manifestUri.fsPath,
    selection.environment.name,
    selection.resolution.platform,
    {
      tag: selection.tag,
      command: selection.command,
      ...destination,
    },
  );
}

async function showPreview(recipe: string, files: readonly string[]): Promise<void> {
  const recipeDocument = await workspace.openTextDocument({
    language: 'dockerfile',
    content: recipe,
  });
  const filesDocument = await workspace.openTextDocument({
    language: 'plaintext',
    content: files.length === 0 ? '' : `${files.join('\n')}\n`,
  });
  await window.showTextDocument(recipeDocument, { preview: false });
  await window.showTextDocument(filesDocument, { preview: false, viewColumn: 2 });
}

export async function previewWorkspaceImage(options: WorkspaceActionOptions): Promise<void> {
  try {
    const selection = await selectImage(options);
    if (selection === undefined) {
      return;
    }
    await revalidateSelection(options, selection);
    const result = await preview(options, selection, { load: true });
    await showPreview(result.recipe, result.files);
  } catch (error) {
    await reportError(options, error);
  }
}

async function selectDestination(
  projectUri: Uri,
  tag: string,
): Promise<WorkspaceImageDestination | undefined> {
  const selected = await window.showQuickPick<DestinationQuickPickItem>(
    [
      {
        label: 'Load into Docker',
        description: 'Load the built image into the local Docker image store',
        destination: 'load',
      },
      {
        label: 'Export OCI archive',
        description: 'Write a standard OCI image archive without publishing it',
        destination: 'output',
      },
    ],
    {
      title: 'Select a workspace image destination',
      placeHolder: 'Choose one build destination',
      ignoreFocusOut: true,
    },
  );
  if (selected === undefined) {
    return undefined;
  }
  if (selected.destination === 'load') {
    return { load: true };
  }
  const filename = `${tag.replace(/[^a-zA-Z0-9._-]+/g, '-')}.oci.tar`;
  const output = await window.showSaveDialog({
    defaultUri: Uri.joinPath(projectUri, filename),
    filters: { 'OCI image archive': ['tar'] },
    saveLabel: 'Export OCI Image',
    title: 'Choose the OCI image archive destination',
  });
  return output === undefined ? undefined : { output: output.fsPath };
}

export async function buildWorkspaceImage(options: WorkspaceActionOptions): Promise<void> {
  try {
    const selection = await selectImage(options);
    if (selection === undefined) {
      return;
    }
    const destination = await selectDestination(selection.context.projectUri, selection.tag);
    if (destination === undefined) {
      return;
    }
    await revalidateSelection(options, selection);
    await preview(options, selection, destination);
    const task = createWorkspaceImageTask(options.workspaces, selection.context.manifestUri, {
      environment: selection.environment.name,
      platform: selection.resolution.platform,
      tag: selection.tag,
      command: selection.command,
      ...destination,
    });
    await vscodeTasks.executeTask(task);
    void window.showInformationMessage(
      'Workspace image build started in VS Code Tasks. Docker with Buildx and a running daemon are required.',
    );
  } catch (error) {
    await reportError(options, error);
  }
}
