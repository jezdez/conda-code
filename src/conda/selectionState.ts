import type { Memento, Uri } from 'vscode';

const DEFAULT_SELECTIONS_KEY = 'conda-workspaces.selected-environments';
const CONDA_SELECTIONS_KEY = 'conda.selected-environments';

type StoredSelections = Record<string, string>;

function projectKey(project: Uri): string {
  return project.toString(true);
}

function scopeKey(scope: Uri | undefined): string {
  return scope === undefined ? 'global' : projectKey(scope);
}

export class CondaSelectionState {
  private pendingWrite: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: Memento,
    private readonly selectionsKey = CONDA_SELECTIONS_KEY,
  ) {}

  public async get(scope: Uri | undefined): Promise<string | undefined> {
    await this.pendingWrite;
    return this.read()[scopeKey(scope)];
  }

  public set(scope: Uri | undefined, environmentId: string | undefined): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const selections = this.read();
      const key = scopeKey(scope);
      if (environmentId === undefined) {
        delete selections[key];
      } else {
        selections[key] = environmentId;
      }
      await this.state.update(this.selectionsKey, selections);
    });
    return this.pendingWrite;
  }

  public async entries(): Promise<Readonly<Record<string, string>>> {
    await this.pendingWrite;
    return this.read();
  }

  public clear(): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(() =>
      this.state.update(this.selectionsKey, undefined),
    );
    return this.pendingWrite;
  }

  private read(): StoredSelections {
    return { ...this.state.get<StoredSelections>(this.selectionsKey, {}) };
  }
}

/**
 * Persists only the selected environment ID for each VS Code project.
 *
 * Environment details are rebuilt by discovery and never serialized here.
 */
export class CondaWorkspaceSelectionState {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: Memento,
    private readonly selectionsKey = DEFAULT_SELECTIONS_KEY,
  ) {}

  async get(project: Uri): Promise<string | undefined> {
    await this.pendingWrite;
    return this.read()[projectKey(project)];
  }

  set(project: Uri, environmentId: string | undefined): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const selections = this.read();
      const key = projectKey(project);

      if (environmentId === undefined) {
        delete selections[key];
      } else {
        selections[key] = environmentId;
      }

      await this.state.update(this.selectionsKey, selections);
    });

    return this.pendingWrite;
  }

  clear(): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(() =>
      this.state.update(this.selectionsKey, undefined),
    );
    return this.pendingWrite;
  }

  private read(): StoredSelections {
    return { ...this.state.get<StoredSelections>(this.selectionsKey, {}) };
  }
}
