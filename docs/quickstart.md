# Quickstart

This guide installs Conda Code, selects its provider, and checks both sources of
environments.

## 1. Prepare conda

Conda Code requires conda 26.3 or newer. Install conda-workspaces in the same
base environment to enable workspace support. Update conda through the channels
configured for your distribution, then follow the
[conda-workspaces installation instructions](https://conda-incubator.github.io/conda-workspaces/quickstart/#installation).

Confirm that the commands Conda Code uses are available:

```console
conda info --json
conda workspace --help
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

## 4. Check a regular environment

Create a named environment outside VS Code:

```console
conda create -n conda-code-demo python
```

Run **Conda Code: Refresh Environments** from the Command Palette. The
`conda-code-demo` environment appears below **Conda Code** and can be selected
for a Python project.

## 5. Check a workspace

Open a folder that is registered as a Python project, then create a workspace:

```console
cd /path/to/project
conda workspace quickstart --yes --no-shell --format conda -- python
```

Run **Conda Code: Refresh Environments** again. The installed workspace
environment appears in the same provider, grouped by workspace name.

Next, follow the tutorial for a
[](tutorials/regular-environment.md) or a
[](tutorials/workspace-environment.md).
