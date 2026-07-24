# Settings and commands

## Provider IDs

| Role                | ID                        |
| ------------------- | ------------------------- |
| Environment manager | `jezdez.conda-code:conda` |
| Package manager     | `jezdez.conda-code:conda` |

## Conda Code setting

### `conda-code.condaExecutable`

Absolute path or command name for the conda executable.

- Type: string
- Default: empty
- Scope: machine-overridable

An empty value uses this precedence:

1. `CONDA_EXE`
2. `python.condaPath`
3. `conda` on `PATH`

## Related Python Environments settings

| Setting                                       | Conda Code value or use                                  |
| --------------------------------------------- | -------------------------------------------------------- |
| `python-envs.defaultEnvManager`               | `jezdez.conda-code:conda`                                |
| `python-envs.defaultPackageManager`           | `jezdez.conda-code:conda`                                |
| `python-envs.pythonProjects[].envManager`     | Select Conda Code for one project                        |
| `python-envs.pythonProjects[].packageManager` | Select Conda Code packages for one project               |
| `python-envs.pythonProjects[].path`           | Registered project root used for workspace discovery     |
| `python.condaPath`                            | Fallback conda path when the Conda Code setting is empty |

## Commands

### `Conda Code: Refresh Environments`

Command ID: `conda-code.refresh`

Clears the package cache and refreshes regular and workspace environments.
Conda Code also schedules refreshes when `conda.toml`, `pixi.toml`,
`pyproject.toml`, or `conda.lock` changes.

Project creation inputs such as `environment.yml`, `explicit.txt`, and
`conda-lock.yml` are not watched.
