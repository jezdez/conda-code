# Ecosystem fit

Conda Code connects Visual Studio Code to conda itself and to a small set of
related tools that affect environment discovery, package records, or task
execution.

## conda-workspaces

[conda-workspaces](https://conda-incubator.github.io/conda-workspaces/) defines
project manifests, declared environments, features, tasks, and workspace
commands. Conda Code provides VS Code integration for installed workspace
environments and declared tasks.

It uses `conda workspace` for environment discovery and changes, and
`conda task` for tasks. Regular conda support does not require a workspace
manifest.

Conda Code publishes tasks from the workspace manifest selected for a
registered Python project. It uses `conda task list` for discovery and
`conda task run` for execution. conda-workspaces remains responsible for the
task graph, platform behavior, variables, and caching. Conda Code passes the
selected Conda Code workspace environment when it belongs to the same
manifest. It does not parse or edit task definitions.

## conda-pypi

[conda-pypi](https://github.com/conda/conda-pypi) gives installed PyPI packages
conda records. Conda Code lists those records like other conda packages while
omitting raw pip-only distributions.

For workspace `[pypi-dependencies]`, conda-workspaces and conda-pypi solve and
record those dependencies. Package changes started in Conda Code apply to the
workspace's conda dependencies.

## conda-lockfiles

[conda-lockfiles](https://github.com/conda/conda-lockfiles) registers
additional exact environment formats with `conda`. When it is installed, Conda
Code can pass project-root `conda-lock.yml` and `conda-lock.yaml` files to
`conda create`.

The conda-lockfiles plugin also supports `pixi.lock`. Conda Code does not offer that file
as a standalone environment input. Pixi projects stay with Pixi Code when it is
installed, or with conda-workspaces otherwise.

Conda Code does not parse or synchronize those files. It delegates the format
to `conda` and manages the result as a regular named environment.

## conda-global

[conda-global](https://github.com/conda-incubator/conda-global) creates isolated
tool environments and exposes their commands through PATH trampolines. Those
prefixes are implementation details of globally installed tools, not project
environment choices.

Conda Code skips the active tool root:

1. `$CONDA_GLOBAL_HOME/envs` when configured
2. `~/.conda/global/envs` for the current layout
3. `~/.cg/envs` for an existing legacy installation

## Pixi Code

[Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)
is the Python Environments provider for Pixi projects. It is closer to Conda
Code than a Python-only environment manager because Pixi also manages conda
packages and project environments.

The extensions can be installed together. When Pixi Code is present, Conda
Code leaves `pixi.toml`, `[tool.pixi]`, and `.pixi/envs` to Pixi Code while
continuing to handle regular conda environments and `conda.toml` projects.
That rule also applies to task discovery. When Pixi Code is installed, Conda
Code does not publish tasks from `pixi.toml` or a `pyproject.toml` project with
a `[tool.pixi]` table.

## Python Environments

Python Environments supplies the common VS Code view and extension API. Conda
Code supplies conda-specific behavior through that API. The built-in conda
manager remains separate because the current API supports registration, not
replacement.
