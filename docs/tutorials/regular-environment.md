# Create a named conda environment

This tutorial creates a regular named conda environment through the Python
Environments interface.

## Before you start

Complete the [](../quickstart.md), open a local folder in VS Code, and make sure
the folder appears as a Python project in the Python Environments view.

## Create the environment

1. Run **Python Envs: Create Environment** from the Command Palette.
2. Select **Conda Code** if VS Code asks for an environment manager.
3. Choose **Named environment**.
4. Enter `conda-code-demo`.
5. Choose a Python version or accept the default package selection.

Conda Code creates the environment in one of conda's configured environment
directories. It contains Python and appears below **Conda Code**.

Inspect it from a terminal:

```console
conda list --name conda-code-demo
```

## Add a package

1. Expand the new environment in the Python Environments view.
2. Open **Manage Packages**.
3. Install `pytest`.

Conda Code applies the change with the configured conda executable.

```console
conda list --name conda-code-demo pytest
```

## Use the environment

Set the environment for the project, then create a Python terminal from the
Python Environments view.

```console
python -c "import sys; print(sys.prefix)"
```

The printed prefix matches the `conda-code-demo` environment shown by
`conda info --envs`.

## What happened

The environment is an ordinary named conda prefix with `conda-meta` records.
Core conda commands see the same environment model. Conda Code adds the VS Code
integration, not a new regular environment format.
