# Use conda workspaces

This is the optional conda-workspaces integration. For regular conda projects,
create a named environment from `environment.yml` instead.

::::{card} Run a workspace task from its manifest
:class-card: sd-shadow-sm

:::{image} ../_static/conda-workspace-demo.gif
:alt: The demo opens conda.toml, selects the Conda Code play action, chooses verify-workspace, and shows its terminal output.
:::

Conda Code discovers the task through conda-workspaces. Its editor action opens
the task picker, then VS Code runs the selected task in a terminal.
::::

(workspace-sidebar)=

## Know which part does what

Four components contribute to the workspace experience:

::::{grid} 1 1 2 2
:gutter: 2

:::{grid-item-card} {octicon}`project` Python Environments

Owns the shared **Python Projects** and **Environment Managers** views. Register
the project here, then select environments from the shared tree.
:::

:::{grid-item-card} {octicon}`plug` Conda Code

Adds the **Conda Code** branch, supplies environment and package records, routes
workspace operations, and contributes **Run Workspace Task**.
:::

:::{grid-item-card} {octicon}`package` conda-workspaces

Owns the manifest, declared environments, installed workspace state, dependency
changes, task graph, and task execution.
:::

:::{grid-item-card} {octicon}`terminal` VS Code Tasks

Shows the task picker, starts the process, and owns the task terminal. Conda
Code hands it the selected `conda task` invocation.
:::

::::

## Register the project

Open the Python Environments project creator flow and choose **Find conda
workspace projects**. Select one or more unregistered candidates. The finder
runs only when invoked.

Supported candidate names are:

- `conda.toml`
- `pixi.toml`
- `pyproject.toml`

Conda Code validates each selected manifest with structured `conda workspace
info` output and registers only valid manifest directories. A matching filename
alone is not enough.

## Run a declared task

Save the task in the manifest. Select the Conda Code workspace environment that
should run it, open the manifest, then select the {octicon}`play` **Run Workspace
Task** action in the editor title. Choose the declared task. The demo selects
`verify-workspace`.

You can also run **Conda Code: Run Workspace Task** from the Command Palette.
The generic **Tasks: Run Task** command remains available for all discovered
`conda-workspace` tasks.

Conda Code asks conda-workspaces to list the tasks from the selected manifest
and delegates the selected task to `conda task`. When the selected environment
belongs to that manifest, Conda Code passes its workspace environment name.
Otherwise conda-workspaces applies the task's declared environment or the
workspace default.

Conda Code does not parse or edit task definitions. This integration does not
add task arguments. Put fixed options in the task definition or use
`conda task` directly when arguments are required.

See the
[conda-workspaces task documentation](https://conda-incubator.github.io/conda-workspaces/features/#tasks)
for task definition syntax.

## Install a declared environment

Run **Python Envs: Create Environment** for the project. If the workspace has
one uninstalled environment, Conda Code installs it. If it has several, select
one from the prompt.

Quick Create also adds Python when the declaration needs it. See
[](../reference/environment-operations.md) for how additional packages are
targeted with different conda-workspaces capabilities.

## Manage dependencies

Use **Manage Packages** to add a conda dependency. Conda Code records it through
`conda workspace add` in the selected environment and updates the installed
environment.

When conda-workspaces reports declaration locations, you can also remove a
direct dependency or update a direct conda dependency. Adding an existing
direct conda dependency updates its original declaration rather than creating
an environment-local duplicate. Conda Code asks before changing a top-level
default or feature declaration, including a platform-qualified declaration in
either shared scope.

Transitive dependencies, PyPI updates, and PyPI packages whose installed name
does not match their declaration remain read-only. If an operation is refused,
edit the manifest, apply the workspace change, then run **Conda Code: Refresh
Environments**. The [](../reference/package-operations.md) lists the exact
capabilities and limits.

## Clean an installed environment

Use **Delete Environment**. Conda Code runs `conda workspace clean` for the
declared environment. It does not remove the declaration from the manifest.
