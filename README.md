# Conda Code

Conda Code provides conda environment and package management through the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It defines its own conda provider for regular environments and adds
[conda-workspaces](https://github.com/conda-incubator/conda-workspaces) as a
project-aware layer.

The registered environment manager and package manager ID is
`jezdez.conda-code:conda`.

## Features

### Regular conda environments

These are standard conda prefixes. The `conda env` command is another CLI
surface over the same environment model. Conda Code discovers those prefixes
through `conda info --json` and does not introduce a separate regular environment
format.

- Discover the base environment and registered named or prefix environments from
  `conda info --json`
- Read Python metadata directly from each prefix without starting its interpreter
- Keep environments without Python visible so they can be repaired or managed
- Create named environments
- Create a project environment at `.conda`
- Remove named environments and project `.conda` prefixes while protecting base
  installations and unowned prefixes
- List, install, update, and remove packages with the configured conda executable
- Show conda records, including conda-pypi packages, and omit raw pip-only
  distributions
- Resolve environments by prefix or Python executable
- Persist global and project selections
- Run Python directly or activate it with hooks from the configured conda root

### Conda workspaces

- Find `conda.toml`, `pixi.toml`, and compatible `pyproject.toml` manifests at
  registered Python project roots
- Validate candidates through `conda workspace info --json`
- Publish installed workspace environments, including environments that do not
  yet contain Python
- Install declared environments and clean their prefixes without deleting the
  manifest declaration
- Create a new `conda.toml` project through quick create
- List installed packages and distinguish direct from transitive dependencies
- Add conda dependencies for environments backed by zero or one feature
- Refuse workspace dependency removal, package upgrades, and additions to
  composite environments
- Refresh when a manifest or `conda.lock` changes

Conda Code publishes each prefix once. When exactly one workspace reports a
prefix, environment and package changes use the workspace commands instead of
the regular conda commands.

When multiple workspace manifests report the same prefix, Conda Code hides that
prefix and refuses environment or package changes until only one manifest
reports it.

## Other tools

### conda-pypi

[conda-pypi](https://github.com/conda/conda-pypi) packages have ordinary conda
records, so Conda Code lists and manages them like other conda packages. Conda
Code does not list raw pip-only distributions.

conda-workspaces and conda-pypi handle workspace `[pypi-dependencies]`. Package
changes from the Python Environments view apply to conda dependencies.

### conda-global

[conda-global](https://github.com/conda-incubator/conda-global) manages isolated
tool environments and PATH trampolines. Conda Code skips prefixes below its
active environment root:

1. `$CONDA_GLOBAL_HOME/envs` when configured
2. `~/.conda/global/envs` after migration or for a new installation
3. `~/.cg/envs` for an existing legacy installation

### Pixi Code

Conda Code and
[Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)
can be installed together. Conda Code excludes `.pixi/envs` from regular conda
discovery. When Pixi Code is installed, Conda Code ignores `pixi.toml` and
`[tool.pixi]` projects during workspace discovery and does not create
`conda.toml` in those projects. It continues to handle `conda.toml` and other
conda-workspaces projects.

## Python Environments built-in conda provider

Python Environments currently registers `ms-python.python:conda`
unconditionally. Its public API does not provide a supported way for another
extension to replace, hide, or disable that manager, and it does not deduplicate
prefixes across managers.

Conda Code does not call or delegate to that implementation. Until Python
Environments allows another extension to replace the built-in provider, both
conda branches can appear in the environment view. Select
`jezdez.conda-code:conda` as `python-envs.defaultEnvManager` or as the
`envManager` for a `python-envs.pythonProjects` entry to use Conda Code for
project operations.

## Creation behavior

- Quick create in a normal project creates `conda.toml` and installs the default
  workspace environment
- Quick create refuses to add `conda.toml` to a Pixi project when Pixi Code is
  installed
- Create in an existing conda workspace installs a declared environment that is
  not installed yet
- Interactive project creation offers a conda workspace, a regular `.conda`
  prefix, or a named environment
- Global and multi-project creation creates a named environment
- Quick global and multi-project creation generates an available name without a
  prompt
- Quick create and newly declared environments include Python unless the
  requested package list or existing workspace declaration already contains a
  Python specification

## Execution and activation

Python execution uses the absolute interpreter inside the prefix. For Bash, Zsh,
POSIX sh, Fish, PowerShell, Git Bash, and Command Prompt, regular environments
advertise shell-specific activation commands that load hooks from the configured
conda root before activation. Other shells use direct interpreter execution.

Workspace environments use direct interpreter execution. Conda Code does not
advertise `conda workspace shell` as terminal activation because that command
starts a nested blocking shell.

## Requirements

- Visual Studio Code 1.118 or newer
- Python Environments
- conda 26.3 or newer
- A local file workspace
- conda-workspaces 0.7 or newer for workspace features
- conda-pypi 0.9 or newer and conda-rattler-solver 0.0.6 or newer for workspace
  PyPI dependencies

Set `conda-code.condaExecutable` when the desired conda is not available through
`CONDA_EXE`, the Python extension's `python.condaPath` setting, or `PATH`.

## Usage

Install Conda Code and open the Python Environments view. The Conda Code provider
lists regular conda environments immediately. Opening a registered Python project
with a supported workspace manifest adds its installed workspace environments to
the same provider.

Run `Conda Code: Refresh Environments` after an external change when automatic
manifest refresh is not sufficient.

## Development

Use the Node.js release pinned in `.nvmrc`.

```console
npm ci
npm run typecheck
npm test
```

Run the `Extension` launch configuration in an Extension Development Host.
Build an installable package with:

```console
npm run vsix
```
