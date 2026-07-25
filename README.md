# Conda Code

[![Docs](https://github.com/jezdez/conda-code/actions/workflows/docs.yml/badge.svg)](https://github.com/jezdez/conda-code/actions/workflows/docs.yml)

Conda Code adds conda environment and package management to the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It provides its own conda provider for regular environments and integrates
[conda-workspaces](https://github.com/conda-incubator/conda-workspaces) for
project environments and tasks. It does not call the Python Environments
extension's built-in conda provider.

The environment and package manager ID is `jezdez.conda-code:conda`.

## Install

Install
[Conda Code from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code)
or run:

```console
code --install-extension jezdez.conda-code
```

Python Environments is installed as an extension dependency.

## Features

- Discovers regular conda environments without running their Python
  interpreters
- Classifies base, named, and prefix environments
- Routes activation, package changes, and safe deletion through the conda
  installation that owns each prefix
- Keeps environments without Python visible
- Creates named environments from package specifications, `environment.yml`,
  [CEP 23](https://conda.org/learn/ceps/cep-0023/) explicit files, and
  [conda-lockfiles](https://github.com/conda/conda-lockfiles)
- Lists conda package records, including
  [conda-pypi](https://github.com/conda/conda-pypi) packages
- Discovers, installs, and manages conda-workspaces environments
- Publishes conda workspace tasks through the native VS Code task interface
- Ignores [conda-global](https://github.com/conda-incubator/conda-global) tool
  prefixes and Pixi-owned `.pixi/envs` prefixes
- Coexists with
  [Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)

Python Environments currently registers its built-in conda provider
unconditionally and does not deduplicate environments across providers. Select
`jezdez.conda-code:conda` in your Python Environments settings to use Conda Code
for project operations.

## Requirements

- Visual Studio Code 1.118 or newer
- Python Environments
- conda 26.3 or newer
- A trusted VS Code window
- conda-workspaces 0.7 or newer for workspace features
- conda-lockfiles 0.2 or newer for conda lockfile creation inputs

Workspace discovery and project creation require a local project registered
with Python Environments. Workspace PyPI dependencies require conda 26.5 or
newer.

Set `conda-code.condaExecutable` when the primary conda is not available through
`CONDA_EXE`, the Python extension's `python.condaPath` setting, or `PATH`.

## Usage

Open the Python Environments view and select the Conda Code provider. Opening a
registered project with a supported workspace manifest adds its installed
workspace environments. Tasks declared by that manifest appear under
**Tasks: Run Task** with the `conda-workspaces` source.

Conda Code watches conda-reported configuration files and workspace manifests.
Run **Conda Code: Refresh Environments** to force a refresh after an external
change.

## Documentation

The [Conda Code documentation](https://jezdez.github.io/conda-code/) includes:

- [Tutorials](https://jezdez.github.io/conda-code/tutorials/)
- [How-to guides](https://jezdez.github.io/conda-code/how-to/)
- [Reference](https://jezdez.github.io/conda-code/reference/)
- [Explanations](https://jezdez.github.io/conda-code/explanation/)

## Development

Use the Node.js release pinned in `.nvmrc`.

```console
npm ci
npm run typecheck
npm test
npm run docs
```

Run the `Extension` launch configuration in an Extension Development Host.
Build an installable package with `npm run vsix`.

## License

Conda Code is distributed under the
[BSD 3-Clause License](https://github.com/jezdez/conda-code/blob/main/LICENSE).
