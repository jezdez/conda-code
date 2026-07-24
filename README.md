# Conda Code

[![Docs](https://github.com/jezdez/conda-code/actions/workflows/docs.yml/badge.svg)](https://github.com/jezdez/conda-code/actions/workflows/docs.yml)

Conda Code provides conda environment and package management through the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It defines its own conda provider for regular environments and uses
[conda-workspaces](https://github.com/conda-incubator/conda-workspaces) as a
project-aware layer. It also publishes conda-workspaces tasks through the
native VS Code task interface.

The registered environment manager and package manager ID is
`jezdez.conda-code:conda`.

Read the [Conda Code documentation](https://jezdez.github.io/conda-code/) for
tutorials, how-to guides, reference material, and explanations.

## Install

Install
[Conda Code from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code)
or run:

```console
code --install-extension jezdez.conda-code
```

Python Environments is installed as an extension dependency.

## Features

### Regular conda environments

These are standard conda prefixes. Conda Code discovers them through
`conda info --json` and manages them with core conda commands. The `conda env`
command group refers to the same prefixes but is not used by Conda Code.

- Discover the base environment and registered named or prefix environments from
  `conda info --json`
- Read Python metadata directly from each prefix without starting its interpreter
- Keep environments without Python visible so they can be repaired or managed
- Create named environments
- Create named environments from project-root `environment.yml`,
  `environment.yaml`, and exact package inputs
- Create a project `.conda` prefix only when selected explicitly during
  interactive creation
- Remove named environments and project `.conda` prefixes while protecting base
  installations and other prefix environments
- List, install, update, and remove packages with the configured conda executable
- Show conda records, including conda-pypi packages, and omit raw pip-only
  distributions
- Resolve environments by prefix or Python executable
- Persist the manager-wide and project selections in the current VS Code
  workspace
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
- Expose declared workspace tasks through the native VS Code task interface
  while delegating discovery and execution to `conda task`
- Run a task in the selected Conda Code workspace environment when it belongs
  to the same manifest
- Refresh when a manifest or `conda.lock` changes

Conda Code publishes each prefix once. When exactly one workspace reports a
prefix, environment and package changes use the workspace commands instead of
the regular conda commands.

When multiple workspace manifests report the same prefix, Conda Code hides that
prefix. Removal and package operations refuse stale references to that prefix
until only one manifest reports it.

## Other tools

### conda-pypi

[conda-pypi](https://github.com/conda/conda-pypi) packages have ordinary conda
records, so Conda Code lists those records with other conda packages. Regular
package changes continue to use conda. Conda Code does not list raw pip-only
distributions.

conda-workspaces and conda-pypi handle workspace `[pypi-dependencies]`. Package
changes from the Python Environments view apply to conda dependencies.

Workspace PyPI dependencies require conda 26.5 or newer, the Rattler solver, the
`conda-pypi` channel, and flexible channel priority. See the
[conda-pypi setup](https://conda.github.io/conda-pypi/quickstart/).

### conda-lockfiles

With
[conda-lockfiles](https://github.com/conda/conda-lockfiles) installed
in the configured conda base environment, Conda Code can create exact named
environments from project-root `conda-lock.yml` and `conda-lock.yaml` files.
Conda-lockfiles also lets conda consume `pixi.lock`. Conda Code leaves that
file with its Pixi project instead of offering it as a standalone environment
input.
Follow the
[conda-lockfiles installation instructions](https://conda.github.io/conda-lockfiles/#installation)
using the channels configured for your conda distribution.

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

- An existing discovered conda workspace takes precedence over project creation
  inputs and offers its uninstalled declarations
- A project-root `environment.yml` or `environment.yaml` is a one-time
  [CEP 24](https://conda.org/learn/ceps/cep-0024/) input to a regular named
  environment
- A project-root `explicit.txt` is an exact
  [CEP 23](https://conda.org/learn/ceps/cep-0023/) input
- With conda-lockfiles installed, `conda-lock.yml` and `conda-lock.yaml` are
  exact inputs
- Quick Create uses the single recognized input and derives an available name
  from the project directory
- Quick Create fails when several recognized inputs exist
- Interactive creation lets the user choose an input and asks for the
  environment name
- Interactive project creation also offers a conda workspace, an explicit
  project `.conda` prefix, or a named environment
- Without an input, Quick Create creates `conda.toml` and installs its default
  workspace environment
- Quick Create refuses to add `conda.toml` to a Pixi project when Pixi Code is
  installed
- Global and multi-project creation creates a named environment
- Quick global and multi-project creation generates an available name without a
  prompt
- Regular environments created from package selections and new workspaces
  include Python unless the requested package list already contains a Python
  specification
- Adding packages while installing an existing workspace declaration requires
  zero or one feature
- Exact inputs refuse additional creation packages and disable configured
  default packages

For file-based creation, Conda Code runs `conda create --name NAME --file FILE`
from the project root. The selected name overrides a YAML `name` or `prefix`.
The input is not watched or synchronized after creation.

## Execution and activation

Python execution uses the absolute interpreter inside the prefix. For Bash, Zsh,
POSIX sh, Fish, PowerShell Core (`pwsh`), Git Bash, and Command Prompt, regular
environments advertise shell-specific activation commands that load hooks from
the configured conda root before activation. Other shells use direct interpreter
execution.

Workspace environments use direct interpreter execution. Conda Code does not
advertise `conda workspace shell` as terminal activation because that command
starts a nested blocking shell.

## Requirements

- Visual Studio Code 1.118 or newer
- Python Environments
- conda 26.3 or newer
- A trusted VS Code window
- A local file project registered with Python Environments for workspace
  and project-input features
- conda-workspaces 0.7 or newer for workspace features
- conda 26.5 or newer for workspace PyPI dependencies
- conda-lockfiles 0.2 or newer for `conda-lock.yml` and `conda-lock.yaml`
  creation inputs

Set `conda-code.condaExecutable` when the desired conda is not available through
`CONDA_EXE`, the Python extension's `python.condaPath` setting, or `PATH`.

## Usage

Install Conda Code and open the Python Environments view. The Conda Code provider
lists regular conda environments immediately. Opening a registered Python project
with a supported workspace manifest adds its installed workspace environments to
the same provider. Tasks declared by that manifest appear under
**Tasks: Run Task** with the `conda-workspaces` source. Select one of that
workspace's Conda Code environments first to run the task there.

Run `Conda Code: Refresh Environments` after an external change when automatic
manifest refresh is not sufficient. The command also refreshes workspace task
discovery.

## Development

Use the Node.js release pinned in `.nvmrc`.

```console
npm ci
npm run typecheck
npm test
npm run docs
```

Run the `Extension` launch configuration in an Extension Development Host.
Build an installable package with:

```console
npm run vsix
```
