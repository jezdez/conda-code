# Quickstart

This guide installs Conda Code, selects its provider, and verifies regular
environment discovery. The final step adds optional conda-workspaces support.

## 1. Prepare conda

Conda Code requires conda 26.3 or newer. Update conda through the channels
configured for your distribution.

Confirm that the primary conda executable is available:

```console
conda info --json
```

## 2. Install Conda Code

Install
[Conda Code from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code)
or run:

```console
code --install-extension jezdez.conda-code
```

Python Environments is installed as an extension dependency.

## 3. Select the provider

Add these settings to your VS Code user or workspace settings:

```json
{
  "python-envs.defaultEnvManager": "jezdez.conda-code:conda",
  "python-envs.defaultPackageManager": "jezdez.conda-code:conda"
}
```

Open the Python Environments view. The **Conda Code** manager lists ordinary
environments from the primary conda and other discovered local conda
installations. Base, Named, and Prefix grouping matches the built-in conda
provider for ordinary environments.

:::{note}
Python Environments also registers its built-in conda manager. Both conda
branches can appear. The provider ID in the settings above selects Conda Code
for creation and package operations.
:::

## 4. Check regular environments

The **Conda Code** manager shows the base environment and the named and prefix
environments found across local conda installations. Select an existing
environment to use it for the current project.

To create a named environment, run **Python Envs: Create Environment**, choose
**Conda Code**, and select **Named environment**. Conda Code refreshes the list
after creation.

Run **Conda Code: Refresh Environments** from the Command Palette after an
external change that is not picked up automatically.

## 5. Optional: Check a workspace

Install conda-workspaces in the same base environment as the primary conda.
Follow the
[conda-workspaces installation instructions](https://conda-incubator.github.io/conda-workspaces/quickstart/#installation),
then confirm the command is available:

```console
conda workspace --help
```

Open a folder that is registered as a Python project, then create a conda
workspace:

```console
cd /path/to/project
conda workspace quickstart --yes --no-shell --format conda -- python
```

Run **Conda Code: Refresh Environments** again. The installed workspace
environment appears in the same provider, grouped by workspace name.

:::{card} Continue with a complete workflow

Follow the tutorial for a [](tutorials/regular-environment.md), create from
[](tutorials/environment-file.md), or build a
[](tutorials/workspace-environment.md).
:::
