# Conda Code

Conda environments, packages, workspaces, and tasks in Visual Studio Code.

:::{image} ../assets/conda-logo.png
:alt: Conda Code logo
:width: 128px
:align: center
:::

Conda Code registers its own provider with the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It brings regular conda environments and project-aware
[conda-workspaces](https://conda-incubator.github.io/conda-workspaces/)
environments into one manager, with package operations and declared workspace
tasks alongside them.

The provider ID is `jezdez.conda-code:conda`. Conda Code runs the configured
`conda` executable directly and does not delegate to Python Environments'
built-in conda manager.

::::{grid} 1 2 2 2
:gutter: 2
:margin: 4 0 4 0

:::{grid-item}

```{button-link} https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code
:color: primary
:expand:

Install from Visual Studio Marketplace
```

:::

:::{grid-item}

```{button-ref} quickstart
:ref-type: doc
:color: primary
:outline:
:expand:

Open the quickstart
```

:::

::::

## One provider for conda

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`stack` Regular conda environments
:link: reference/environment-operations
:link-type: doc

Discover the base environment, named environments, and prefix environments.
Keep environments without Python visible and avoid starting an interpreter
during discovery.
:::

:::{grid-item-card} {octicon}`file-code` Project creation
:link: how-to/create-from-files
:link-type: doc

Create named environments from package specifications, `environment.yml`,
CEP 23 explicit files, and supported conda lockfiles.
:::

:::{grid-item-card} {octicon}`project` conda workspaces
:link: how-to/use-workspaces
:link-type: doc

Find installed manifest environments, route changes through `conda workspace`,
and run declared tasks through native VS Code tasks.
:::

:::{grid-item-card} {octicon}`package` Package management
:link: reference/package-operations
:link-type: doc

List conda package records, change regular environments through their owning
conda installation, and add dependencies to supported workspace environments.
:::

::::

:::{tip}
Conda Code includes conda-pypi records, accepts conda-lockfiles inputs, skips
conda-global tool environments and conda-exec caches, and leaves Pixi projects
to Pixi Code when it is installed. See [](explanation/ecosystem.md) for how the
tools fit together.
:::

## Install

The Marketplace install above is the shortest path. You can also run:

```console
code --install-extension jezdez.conda-code
```

Python Environments is installed as an extension dependency. To build Conda
Code from source, see {ref}`source-build`.

Open the Python Environments view and select **Conda Code**. See the
[](quickstart.md) for the complete setup.

## Learn your way

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

:::{grid-item-card} {octicon}`log` Changelog
:link: changelog
:link-type: doc

See what changed in each Conda Code release.
:::

::::

```{toctree}
:hidden:
:caption: Getting started

quickstart
```

```{toctree}
:hidden:
:caption: Documentation

Tutorials <tutorials/index>
How-to guides <how-to/index>
Reference <reference/index>
Explanation <explanation/index>
```

```{toctree}
:hidden:
:caption: Project

changelog
releasing
license
```
