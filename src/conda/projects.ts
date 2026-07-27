import path from 'node:path';

import type {
  PythonEnvironmentApi,
  PythonProject,
  PythonProjectCreator,
} from '@vscode/python-environments';
import type { LogOutputChannel } from 'vscode';
import { ProgressLocation, Uri, window, workspace } from 'vscode';

import { normalizeEnvironmentPath } from './workspaceRouting';
import type { CondaWorkspacesClient } from './workspaces';

const MANIFEST_PATTERN = '**/{conda.toml,pixi.toml,pyproject.toml}';
const MANIFEST_EXCLUDE = '**/{.git,.conda,.pixi,node_modules}/**';
const MANIFEST_PRIORITY = new Map([
  ['conda.toml', 0],
  ['pixi.toml', 1],
  ['pyproject.toml', 2],
]);

export interface CondaWorkspaceProjectFinderOptions {
  readonly log?: LogOutputChannel;
  readonly shouldHandleManifest?: (manifest: Uri) => boolean | Promise<boolean>;
}

interface ProjectCandidate {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly manifest: Uri;
}

function hasWorkspaceToolTable(contents: string): boolean {
  return /^\s*\[\s*tool\s*\.\s*(?:conda|pixi)(?:\s*\.|\s*\])/m.test(contents);
}

function projectKey(uri: Uri): string {
  return normalizeEnvironmentPath(uri.fsPath);
}

export class CondaWorkspaceProjectFinder implements PythonProjectCreator {
  public readonly name = 'condaWorkspaceProjects';
  public readonly displayName = 'Find conda workspace projects';
  public readonly description = 'Find unregistered projects with a conda workspace manifest';

  public constructor(
    private readonly api: PythonEnvironmentApi,
    private readonly workspaces: CondaWorkspacesClient,
    private readonly options: CondaWorkspaceProjectFinderOptions = {},
  ) {}

  public async create(): Promise<PythonProject[] | undefined> {
    const candidates = await this.findCandidates();
    if (candidates.length === 0) {
      await window.showInformationMessage('No unregistered conda workspace projects found.');
      return undefined;
    }

    const selected = await window.showQuickPick(candidates, {
      title: 'Find conda workspace projects',
      placeHolder: 'Select projects to register',
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selected === undefined || selected.length === 0) {
      return undefined;
    }

    const projects = await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'Validating conda workspace projects',
      },
      async (progress) => {
        const registered = new Set(this.api.getPythonProjects().map(({ uri }) => projectKey(uri)));
        const valid: PythonProject[] = [];
        for (const candidate of selected) {
          progress.report({ message: candidate.description });
          try {
            const info = await this.workspaces.getWorkspaceInfo(candidate.manifest.fsPath);
            const uri = Uri.file(path.dirname(info.manifest));
            const key = projectKey(uri);
            if (registered.has(key)) {
              continue;
            }
            registered.add(key);
            valid.push({
              name: info.name,
              uri,
              description: 'conda workspace project',
              tooltip: info.manifest,
            });
          } catch (error) {
            this.options.log?.warn(
              `Could not validate conda workspace manifest ${candidate.manifest.fsPath}: ${String(error)}`,
            );
          }
        }
        return valid;
      },
    );

    if (projects.length === 0) {
      await window.showInformationMessage('No valid conda workspace projects were selected.');
      return undefined;
    }
    this.api.addPythonProject(projects);
    return projects;
  }

  private async findCandidates(): Promise<ProjectCandidate[]> {
    const manifests = await workspace.findFiles(MANIFEST_PATTERN, MANIFEST_EXCLUDE);
    manifests.sort((left, right) => {
      const directoryOrder = path.dirname(left.fsPath).localeCompare(path.dirname(right.fsPath));
      if (directoryOrder !== 0) {
        return directoryOrder;
      }
      return (
        (MANIFEST_PRIORITY.get(path.basename(left.fsPath).toLowerCase()) ?? 99) -
        (MANIFEST_PRIORITY.get(path.basename(right.fsPath).toLowerCase()) ?? 99)
      );
    });

    const registered = new Set(this.api.getPythonProjects().map(({ uri }) => projectKey(uri)));
    const directories = new Set<string>();
    const candidates: ProjectCandidate[] = [];
    for (const manifest of manifests) {
      const directory = path.dirname(manifest.fsPath);
      const key = normalizeEnvironmentPath(directory);
      if (
        directories.has(key) ||
        registered.has(key) ||
        (this.options.shouldHandleManifest !== undefined &&
          !(await this.options.shouldHandleManifest(manifest))) ||
        !(await this.isCandidateManifest(manifest))
      ) {
        continue;
      }
      directories.add(key);
      candidates.push({
        label: path.basename(directory),
        description: directory,
        detail: path.basename(manifest.fsPath),
        manifest,
      });
    }
    return candidates;
  }

  private async isCandidateManifest(manifest: Uri): Promise<boolean> {
    if (path.basename(manifest.fsPath).toLowerCase() !== 'pyproject.toml') {
      return true;
    }
    try {
      const contents = new TextDecoder().decode(await workspace.fs.readFile(manifest));
      return hasWorkspaceToolTable(contents);
    } catch {
      return false;
    }
  }
}
