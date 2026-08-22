# Manage environments and packages

## Create a regular environment

Run **Python Envs: Create Environment**, choose **Conda Code**, then choose one
of the regular environment types:

Named environment
: Creates an environment by name in one of the environment directories
configured for the primary conda.

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

Conda Code routes removal through the prefix's owning conda installation. It
refuses to remove the base environment, another conda installation, a prefix
that it cannot identify as named or `<project>/.conda`, a prefix without a usable
owner executable, or a prefix without valid `conda-meta` data.

## Manage packages

Open **Manage Packages** below a Conda Code environment.

For regular environments, Conda Code can:

- install packages
- update requested packages
- remove packages
- list conda package records

Package changes use the prefix's owner executable. Conda Code keeps a prefix
without a usable owner executable visible but refuses to change it.

Raw pip-only distributions are omitted. Packages installed by conda-pypi have
conda records and remain visible.

See the [](../reference/package-operations.md) for the workspace differences.

## Export an environment SBOM

1. Install conda-sboms 0.3.0 or newer from conda-forge by running this through
   the routed conda executable:

   ```console
   conda install --name base --channel conda-forge "conda-sboms>=0.3.0"
   ```

   Replace `conda` with `cx`, `cxz`, or the configured executable path when
   needed. The
   [installation guide](https://conda-incubator.github.io/conda-sboms/how-to/install/)
   covers alternative methods.

2. Run the routed executable with `export --help` and confirm that
   `cyclonedx-json-v1.7` is listed.
3. Select the Conda Code environment for the active editor scope.
4. Run **Conda Code: Export Environment SBOM** and choose the JSON destination.

The save dialog proposes `<environment>.cdx.json`. Conda Code exports with
`--from-history`, which preserves requested package roots when conda history
contains them while the SBOM still includes the resolved package set.

For a regular environment, install the plugin beside the conda executable that
owns its prefix. For a workspace environment, install it beside the configured
primary conda executable.
