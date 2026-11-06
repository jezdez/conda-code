# Workspace tasks

Conda Code implements a native VS Code task provider for tasks declared in
workspace manifests.

## Discovery scope

Tasks are discovered only from the workspace manifest selected by
[](workspace-discovery.md) for a Python project registered with Python
Environments. A matching file elsewhere in the VS Code window is not a task
source. Task-only manifests are not included.

The Pixi Code coexistence rule applies before task discovery. When Pixi Code is
installed, Conda Code skips every `pixi.toml` and every `pyproject.toml` workspace
with a `[tool.pixi]` table, including its tasks.

For each selected manifest, Conda Code runs:

```console
conda task --file /path/to/manifest list --json
```

Conda Code publishes workspace tasks returned by conda-workspaces. It omits
user-level tasks marked with `source: "user"` so they are not repeated for
every workspace. Conda Code does not parse the manifest's task tables.

## VS Code task definition

The task type is `conda-workspace`. Its definition has two required string
properties:

| Property | Meaning                                 |
| -------- | --------------------------------------- |
| `task`   | Declared workspace task name            |
| `file`   | Workspace-folder-relative manifest path |

Discovered tasks use `conda-workspaces` as their VS Code source.

## Execution

When a Conda Code workspace environment is selected for the same manifest,
Conda Code delegates execution to:

```console
conda task --file /path/to/manifest run --environment=ENVIRONMENT -- TASK
```

Otherwise it leaves environment selection to conda-workspaces:

```console
conda task --file /path/to/manifest run -- TASK
```

Conda Code resolves the definition's `file` value against its VS Code workspace
folder and passes the absolute path to `conda`. The `--` separator keeps task
names from being interpreted as command options.

VS Code supplies the task UI and terminal. conda-workspaces handles dependency
ordering, task and dependency environment overrides, platform overrides,
variables, caching, and the task command itself. Without a matching VS Code
selection, conda-workspaces uses the task's declared environment or the
workspace default.

Conda Code does not edit task definitions and does not add task arguments.

## User interface

Open a confirmed workspace manifest and select the {octicon}`play` **Run
Workspace Task** action in the editor title. The command lists tasks only from
that manifest and executes the selected native VS Code task. The same action is
available as **Conda Code: Run Workspace Task** in the Command Palette.

The generic **Tasks: Run Task** command lists discovered tasks from every
registered workspace.

## Refresh

Saving `conda.toml`, `pixi.toml`, or `pyproject.toml` invalidates task
discovery. Running **Conda Code: Refresh Environments** also invalidates it.
