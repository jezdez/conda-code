# Manage environments and packages

## Create a regular environment

Run **Python Envs: Create Environment**, choose **Conda Code**, then choose one
of the regular environment types:

Named environment
: Creates an environment by name in one of conda's configured environment
directories.

Project prefix
: Creates an environment at `.conda` below the registered project. This
secondary option is interactive only.

Conda Code includes Python unless the requested package list already contains a
Python specification.

## Create from a project file

Use [](create-from-files.md) for `environment.yml`, `explicit.txt`, and supported
conda-lock inputs. These create regular named environments.

## Select an environment

Use **Set As Project Environment** in the Python Environments view. A workspace
environment can only be selected for the project that declares it. Regular
environments can be selected for any compatible project.

Conda Code persists the manager-wide and project selections in the current VS
Code workspace.

## Remove an environment

Use **Delete Environment** in the Python Environments view.

Conda Code removes:

- named conda environments
- project prefixes located exactly at `<project>/.conda`

Conda Code refuses to remove the base environment, another conda installation,
a prefix that it cannot identify as named or `<project>/.conda`, or a prefix
without valid `conda-meta` data.

## Manage packages

Open **Manage Packages** below a Conda Code environment.

For regular environments, Conda Code can:

- install packages
- update requested packages
- remove packages
- list conda package records

Raw pip-only distributions are omitted. Packages installed by conda-pypi have
conda records and remain visible.

See the [](../reference/package-operations.md) for the workspace differences.
