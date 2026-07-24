# Conda Code

Conda environments, packages, workspaces, and tasks in Visual Studio Code.

Conda Code registers its own provider with the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It presents regular conda environments and project-aware
[conda-workspaces](https://conda-incubator.github.io/conda-workspaces/)
environments through one manager. It also publishes declared workspace tasks
through the native VS Code task interface.

The provider ID is `jezdez.conda-code:conda`. Conda Code runs the configured
conda executable directly and does not delegate to Python Environments'
built-in conda manager.

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`stack` Regular conda environments

Discover the base environment, named environments, and prefix environments.
Create named environments directly or from project-root environment files,
select environments, remove them, and manage packages.
:::

:::{grid-item-card} {octicon}`project` Conda workspaces

Find installed environments declared by `conda.toml`, compatible `pixi.toml`
files, and compatible `pyproject.toml` tables. Route changes through
`conda workspace` and run declared tasks through native VS Code tasks.
:::

:::{grid-item-card} {octicon}`package` Conda package management

List conda package records, install and remove packages in regular
environments, and add dependencies to supported workspace environments.
:::

:::{grid-item-card} {octicon}`plug` Related conda tools

Include conda-pypi records, accept conda-lockfiles inputs, skip conda-global
tool environments, and coexist with Pixi Code.
:::

::::

## Install

Install
[Conda Code from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code)
or run:

```console
code --install-extension jezdez.conda-code
```

Python Environments is installed as an extension dependency. To build Conda
Code from source, see {ref}`source-build`.

Open the Python Environments view and select **Conda Code**. See the
[](quickstart.md) for the complete setup.

## Choose a path

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`rocket` Quickstart
:link: quickstart
:link-type: doc

Install Conda Code, select its provider, and verify regular and workspace
discovery.
:::

:::{grid-item-card} {octicon}`mortar-board` Tutorials
:link: tutorials/index
:link-type: doc

Create named environments directly and from `environment.yml`, then create a
manifest-backed workspace environment and run one of its tasks.
:::

:::{grid-item-card} {octicon}`tools` How-to guides
:link: how-to/index
:link-type: doc

Configure conda, select the provider, manage environments, run workspace tasks,
and resolve common problems.
:::

:::{grid-item-card} {octicon}`list-unordered` Reference
:link: reference/index
:link-type: doc

Requirements, settings, discovery rules, task definitions, and supported
operation tables.
:::

:::{grid-item-card} {octicon}`light-bulb` Explanation
:link: explanation/index
:link-type: doc

How regular environments, workspaces, provider registration, and related conda
plugins fit together.
:::

:::{grid-item-card} {octicon}`mark-github` Project
:link: changelog
:link-type: doc

Read the changelog, release process, license, and source repository.
:::

::::

```{toctree}
:hidden:
:caption: Getting started

quickstart
```

```{toctree}
:hidden:
:caption: Tutorials

Create a named conda environment <tutorials/regular-environment>
Create from environment.yml <tutorials/environment-file>
Create a workspace environment <tutorials/workspace-environment>
```

```{toctree}
:hidden:
:caption: How-to guides

Select the Conda Code provider <how-to/select-provider>
Configure the conda executable <how-to/configure-conda>
Create from project files <how-to/create-from-files>
Manage environments and packages <how-to/manage-environments>
Use conda workspaces <how-to/use-workspaces>
Coexist with Pixi Code <how-to/coexist-with-pixi-code>
Troubleshoot Conda Code <how-to/troubleshooting>
```

```{toctree}
:hidden:
:caption: Reference

Requirements <reference/requirements>
Settings and commands <reference/settings-and-commands>
Project creation <reference/project-creation>
Environment operations <reference/environment-operations>
Package operations <reference/package-operations>
Workspace discovery <reference/workspace-discovery>
Workspace tasks <reference/workspace-tasks>
```

```{toctree}
:hidden:
:caption: Explanation

Regular environments and workspaces <explanation/environment-model>
Project files, lockfiles, and workspaces <explanation/creation-inputs>
The provider model <explanation/provider-model>
Ecosystem fit <explanation/ecosystem>
```

```{toctree}
:hidden:
:caption: Project

changelog
releasing
license
```
