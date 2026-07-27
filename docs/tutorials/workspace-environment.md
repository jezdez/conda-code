# Create a workspace environment

This tutorial creates a `conda.toml` project and lets conda-workspaces manage
its environment.

## Before you start

Complete the [](../quickstart.md), open a local folder in VS Code, and register
that folder as a Python project.

:::{seealso}
Python Environments draws the shared sidebar and prompts. Conda Code contributes
the **Conda Code** branch and handles operations aimed at it. See
{ref}`workspace-sidebar` for the role of each component.
:::

## Quick create the workspace

1. Open the Python Environments view.
2. Start **Quick Create** for the project.
3. Select **Conda Code** if VS Code asks for an environment manager.

Conda Code runs `conda workspace quickstart` with the conda manifest format. The
project gains a `conda.toml` file and an installed default environment with
Python.

The manifest starts with the same basic shape as:

```toml
[workspace]
name = "example"
channels = ["CONFIGURED_CHANNEL"]
platforms = ["CURRENT_SUBDIR"]

[environments.default.dependencies]
python = "*"
```

The channel and current subdir come from the configured conda installation.
Quick Create places Python in the default environment that it installs.

## Add a dependency

Open **Manage Packages** for the workspace environment and add `pytest`.

Conda Code routes the change through `conda workspace add`. The dependency is
recorded in the manifest and the installed environment is updated.

```console
conda workspace list
```

The package view labels packages as direct or transitive dependencies.
When conda-workspaces reports dependency declaration locations, you can also
remove a direct dependency or update a direct conda dependency from this view.
Conda Code asks before changing a declaration outside the selected
environment's private dependency table.

## Declare a task

Add this task to `conda.toml` and save the file:

```toml
[tasks]
python-version = { cmd = "python --version", description = "Show the Python version" }
```

## Run a task

1. Select the workspace's **default** environment in the Python Environments
   view.
2. Open `conda.toml`.
3. Select the {octicon}`play` **Run Workspace Task** action in the editor title.
4. Select **python-version**.

You can run **Conda Code: Run Workspace Task** from the Command Palette instead.

VS Code opens a task terminal. Conda Code delegates execution to:

```console
conda task --file /path/to/conda.toml run --environment=default -- python-version
```

Conda Code passes the matching selected workspace environment. conda-workspaces
resolves the task graph and runs the declared command.

## Clean and reinstall

Delete the environment from the Python Environments view. Conda Code runs the
workspace clean operation, which removes the installed prefix but keeps the
environment declaration.

Run **Python Envs: Create Environment** for the same project. Conda Code finds
the declared but uninstalled environment and installs it again.

## What happened

The manifest, not the prefix alone, defines the workspace. Conda Code keeps the
environment visible through the same provider as regular conda environments,
then chooses workspace commands whenever that manifest is the single source
reporting the prefix. It also surfaces the manifest's tasks through VS Code
while leaving task execution to conda-workspaces.
