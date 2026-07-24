import type { Memento, Uri } from 'vscode';

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

  private read(): StoredSelections {
    return { ...this.state.get<StoredSelections>(this.selectionsKey, {}) };
  }
}
