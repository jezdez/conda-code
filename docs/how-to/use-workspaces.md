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

Add the manifest directory as a Python project in the Python Environments view.
Conda Code does not treat every matching file in the VS Code window as a
project.

Supported candidate names are:

- `conda.toml`
- `pixi.toml`
- `pyproject.toml`

Conda Code validates the candidate with `conda workspace info --json`. A
matching filename alone is not enough.

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

For an environment backed by zero or one feature, Quick Create adds Python when
the selected declaration does not already contain it. Adding Python or other
creation packages is refused for an environment composed from multiple
features. Edit the manifest to choose a feature, then install the environment.

## Add conda dependencies

Use **Manage Packages** to add a dependency. Conda Code records the dependency
through `conda workspace add` when the environment uses zero or one feature.

For an environment composed from multiple features, edit the manifest to choose
the correct feature explicitly:

```console
conda workspace add --feature dev -- pytest
```

Then run **Conda Code: Refresh Environments**.

## Remove or upgrade a workspace dependency

Edit the manifest directly, run the appropriate `conda workspace` command, then
refresh Conda Code. Package removal and package upgrade are not exposed through
the Python Environments package operation because those operations need
manifest-specific choices.

## Clean an installed environment

Use **Delete Environment**. Conda Code runs `conda workspace clean` for the
declared environment. It does not remove the declaration from the manifest.
