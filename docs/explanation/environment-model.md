# Regular environments and workspaces

Conda Code presents regular conda environments and conda workspace environments
through the same provider. The difference is where the environment definition
lives and which command should change it.

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} Regular environment

The prefix and conda's environment registration are the source. Conda Code uses
core commands such as `conda create`, `conda install`, and `conda remove`.
:::

:::{grid-item-card} Workspace environment

The workspace manifest is the source. Conda Code uses `conda workspace`
commands so changes remain represented by the project.
:::

::::

## `conda env` and regular conda environments

`conda env` is a CLI surface over the same named and prefix environments used
by core conda commands. Conda Code does not define a separate `conda env`
environment type.

The base environment, named environments, and project `.conda` prefixes are all
regular conda prefixes. They contain `conda-meta` package records and can be
inspected with standard conda commands.

A project-root `environment.yml`, `environment.yaml`, or supported exact input
can create a regular named environment through Conda Code. The file is used once
and is not kept in sync with the prefix. See [](creation-inputs.md).

## Why workspaces need a separate route

A workspace prefix is an installed result of a manifest declaration. Changing
only the prefix would leave the declaration and lock data out of sync.

Conda Code therefore associates the installed prefix with the one manifest that
reports it. Package additions and environment cleanup use that association.
If several manifests report the same prefix, Conda Code cannot choose one and
does not publish the environment.

## Why both appear together

The Python Environments view is most useful when a developer can select a
Python environment without first knowing which conda command created it.
Conda Code keeps that common selection surface while preserving the distinct
change path behind each environment.
