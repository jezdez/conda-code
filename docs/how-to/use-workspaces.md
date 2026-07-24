# Use conda workspaces

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
