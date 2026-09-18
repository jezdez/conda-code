# Settings and commands

## Provider IDs

| Role                | ID                        |
| ------------------- | ------------------------- |
| Environment manager | `jezdez.conda-code:conda` |
| Package manager     | `jezdez.conda-code:conda` |

## Conda Code setting

### `conda-code.condaExecutable`

Absolute path or command name for the primary `conda` executable.

[conda-express](https://github.com/jezdez/conda-express) delegates supplied by
this setting, `CONDA_EXE`, or `python.condaPath` are also accepted. Bare `cx`
and `cxz` work on every platform. An executable path's basename must be exactly
`cx` or `cxz` on macOS and Linux, or `cx.exe` or `cxz.exe` on Windows. Conda
Code does not search `PATH` for or install these delegates. Invoking one follows
conda-express's normal bootstrap behavior.

- Type: string
- Default: empty
- Scope: machine-overridable

An empty value uses this precedence:

1. `CONDA_EXE`
2. `python.condaPath`
3. `conda` on `PATH`

The primary conda handles creation, workspaces, tasks, and plugin features. It
does not limit regular environment discovery to one installation. Existing
regular environments use the owning root's conda hooks when an owning `conda`
executable is available. Package changes and safe deletion use that executable.

## Related Python Environments settings

| Setting                                       | Conda Code value or use                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `python-envs.defaultEnvManager`               | `jezdez.conda-code:conda`                                  |
| `python-envs.defaultPackageManager`           | `jezdez.conda-code:conda`                                  |
| `python-envs.pythonProjects[].envManager`     | Select Conda Code for one project                          |
| `python-envs.pythonProjects[].packageManager` | Select Conda Code packages for one project                 |
| `python-envs.pythonProjects[].path`           | Registered project root used for workspace discovery       |
| `python.condaPath`                            | Fallback `conda` path when the Conda Code setting is empty |

## Commands

### `Conda Code: Refresh Environments`

Command ID: `conda-code.refresh`

Clears the package cache and refreshes regular environments, workspace
environments, and workspace task discovery. The command also expires cached
conda information and forces a background `conda info --json` request. The
current environment list remains available while that request runs.

Conda Code automatically schedules the same background enrichment when an exact
configuration file reported by conda changes. A lightweight cache fingerprint
detects changes to reported files, relevant conda environment inputs, or the
configured executable while VS Code was closed. The 24-hour cache age remains a
fallback for sources conda had not reported. Conda Code also schedules refreshes
when `conda.toml`, `pixi.toml`, `pyproject.toml`, or `conda.lock` changes.

Project creation inputs such as `environment.yml`, `explicit.txt`, and
`conda-lock.yml` are not watched.

### `Conda Code: Export Environment SBOM`

Command ID: `conda-code.exportEnvironmentSbom`

Exports the selected Conda Code environment through conda-sboms after choosing
a CycloneDX JSON destination. The save dialog proposes
`<environment>.cdx.json`.

### `Conda Code: Create Environment from File`

Command ID: `conda-code.createEnvironmentFromFile`

Creates a regular named environment from the supported file open in the active
editor, then selects the result for that file's registered Python project. The
file must be at the project root and use one of these exact names:

- `environment.yml`
- `environment.yaml`
- `explicit.txt`
- `conda-lock.yml`
- `conda-lock.yaml`

A {octicon}`plus` action appears in the editor title for those files. When
several supported files exist, the active file is used without another prompt.
See [](project-creation.md) for naming and exact-input behavior.

### `Conda Code: Run Workspace Task`

Command ID: `conda-code.runWorkspaceTask`

Opens a picker containing the tasks declared by the active, confirmed
workspace manifest, then runs the selected native VS Code task. A
{octicon}`play` action appears in the editor title for `conda.toml`, `pixi.toml`,
and `pyproject.toml`. Conda Code validates the active file before asking
conda-workspaces for its tasks.

### `Conda Code: Create Workspace Environment`

Command ID: `conda-code.createWorkspaceEnvironment`

Adds a named environment declaration to a selected existing workspace. The
feature picker includes the default feature and every named feature reported by
conda-workspaces. Clearing the default feature passes `--no-default-feature`.

### `Conda Code: Import environment.yml into Workspace`

Command ID: `conda-code.importWorkspaceEnvironment`

Imports one `environment.yml` or `environment.yaml` as a new named environment
in a selected existing workspace.

### `Conda Code: Remove Workspace Environment Declaration`

Command ID: `conda-code.removeWorkspaceEnvironment`

Removes a selected environment declaration after a modal confirmation. The
operation also removes its complete lock records and installed prefix. Deleting
the environment from the Python Environments view only cleans the prefix and
keeps the declaration.
