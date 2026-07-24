# Create a workspace environment

This tutorial creates a `conda.toml` project and lets conda-workspaces manage
its environment.

## Before you start

Complete the [](../quickstart.md), open a local folder in VS Code, and register
that folder as a Python project.

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
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64", "win-64"]

[dependencies]
python = "*"
```

The exact platforms come from conda-workspaces.

## Add a dependency

Open **Manage Packages** for the workspace environment and add `pytest`.

Conda Code routes the change through `conda workspace add`. The dependency is
recorded in the manifest and the installed environment is updated.

```console
conda workspace list
```

The package view labels packages as direct or transitive dependencies.

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
reporting the prefix.
