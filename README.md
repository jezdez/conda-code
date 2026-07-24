# Conda Code

Conda Code adds project-scoped conda environments and package management to the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).

It uses [conda-workspaces](https://github.com/conda-incubator/conda-workspaces)
for project manifests, environment creation, package operations, and lockfiles.
Regular named and prefix environments remain available through the conda support
built into Python Environments.

## Features

- Find `conda.toml`, `pixi.toml`, and compatible `pyproject.toml` manifests at
  registered Python project roots
- Validate candidates through `conda workspace info --json`
- Publish installed workspace environments that contain Python
- Route and persist environments by their absolute prefix
- Persist the selected environment for each project
- Run Python directly from the workspace prefix
- Install a declared environment or bootstrap a new `conda.toml`
- Clean a workspace prefix while retaining its manifest declaration
- List, add, and remove dependencies through the workspace CLI
- Refresh when a manifest or `conda.lock` changes

## Plugin boundaries

| Component          | Managed resources                                    | Extension treatment                      |
| ------------------ | ---------------------------------------------------- | ---------------------------------------- |
| `conda-workspaces` | Project manifests, environments, features, and tasks | Python environment and package provider  |
| `conda-pypi`       | PyPI dependency translation and installation         | Used through conda-workspaces            |
| `conda-lockfiles`  | Exact environment reproduction                       | Kept behind the workspace and conda CLIs |
| `conda-exec`       | Ephemeral or cached command execution                | Never published as Python environments   |
| `conda-global`     | Persistent isolated tools and PATH trampolines       | Not published as project environments    |

Lockfiles remain an implementation detail of conda-workspaces. The extension
does not parse or rewrite them.

[conda-pypi](https://github.com/conda/conda-pypi) is an optional implementation
dependency of conda-workspaces for workspace `[pypi-dependencies]`. Conda Code
leaves their resolution and installation to conda-workspaces. Package changes
initiated from the Python Environments view target conda dependencies.

[conda-exec](https://github.com/conda-incubator/conda-exec) and
[conda-global](https://github.com/conda-incubator/conda-global) belong to
different lifecycles. Conda-exec cache prefixes are ephemeral execution details.
Conda-global prefixes are persistent, but they are isolated containers for tools
published through PATH trampolines. The extension does not publish either kind
as Python environments, even when a prefix happens to contain Python.
Conda-global prefixes can also appear through stock conda discovery, so
registering them again would produce duplicate entries and conflicting lifecycle
actions.

Dependency changes target the default feature or a single named feature.
Composite environments are left unchanged because package operations require
one target feature.

Conda Code runs the interpreter directly. It does not register terminal
activation because `conda workspace shell` starts a blocking nested shell.

## Requirements

- Visual Studio Code 1.118 or newer
- Python Environments
- conda 26.3 or newer
- conda-workspaces 0.7 or newer installed in the selected conda installation
- For workspace PyPI dependencies, conda-pypi 0.9 or newer and
  conda-rattler-solver 0.0.6 or newer
- A local file workspace

Set `conda-code.condaExecutable` when the desired conda is not available through
`CONDA_EXE`, the Python extension's `python.condaPath` setting, or `PATH`.

## Usage

Open a local project containing `conda.toml`, `pixi.toml`, or a compatible
`pyproject.toml`. Conda Code validates the manifest and publishes its installed
Python environments in the Python Environments view.

Use the Python Environments view to select an environment, install a declared
environment, create a new conda workspace, or manage dependencies. Run
`Conda Code: Refresh Workspace Environments` after an external change when an
automatic refresh is not sufficient.

Conda Code can read Pixi-compatible manifests through conda-workspaces. Use one
environment provider for each Pixi project. Use either Pixi Code or Conda Code
for a Pixi project. Disable the other extension for that workspace.

## Supported behavior

- Local file workspaces
- Manifests at registered Python project roots
- Installed workspace environments containing Python
- Dependency changes for the default feature or one named feature
- Existing workspace PyPI dependencies through conda-workspaces and conda-pypi
- Direct interpreter execution without terminal activation
- Project environments only, excluding conda-exec caches and conda-global tools

## Development

Use the Node.js release pinned in `.nvmrc`.

```console
npm ci
npm run typecheck
npm test
npm run compile
```

Run the `Extension` launch configuration in an Extension Development Host.
Build an installable package with:

```console
npm run vsix
```
