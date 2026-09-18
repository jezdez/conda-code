# Requirements

## Core

| Component           | Requirement                          |
| ------------------- | ------------------------------------ |
| Visual Studio Code  | 1.118 or newer                       |
| Python Environments | Installed as an extension dependency |
| conda               | 26.3 or newer                        |
| Project features    | Local file project                   |
| Workspace trust     | Required                             |

Regular environment discovery does not require a registered project. Project
selection and workspace discovery require local files. Conda Code does not
support virtual or untrusted workspaces because it executes local `conda`
commands.

## conda-workspaces

| Component          | Requirement                                          |
| ------------------ | ---------------------------------------------------- |
| conda-workspaces   | 0.7 or newer                                         |
| Workspace manifest | Validated by `conda workspace info --json`           |
| Python project     | Manifest directory registered in Python Environments |

Conda Code detects optional conda-workspaces capabilities from command output.
A complete workspace snapshot makes discovery faster and allows dependencies to
be added directly to a selected environment. Structured dependency declaration
locations allow direct dependency removal and direct conda dependency updates.
The 0.7-compatible discovery and single-feature package-add path remains
available when those fields are absent.

Creating, importing, and removing workspace environment declarations through
the Command Palette requires conda-workspaces 0.9 or newer. Older supported
versions remain available for discovery, installation, tasks, and compatible
package operations.

## Workspace PyPI dependencies

Workspace `[pypi-dependencies]` support requires conda 26.5 or newer, which
includes conda-pypi and the Rattler solver.

| Component | Requirement   |
| --------- | ------------- |
| conda     | 26.5 or newer |

The configured conda installation must use the Rattler solver, include the
`conda-pypi` channel, and use flexible channel priority:

```console
conda config --set solver rattler
conda config --append channels conda-pypi
conda config --set channel_priority flexible
```

See the [conda-pypi setup](https://conda.github.io/conda-pypi/quickstart/).

Conda Code shows the resulting conda records. A direct PyPI dependency can be
removed when its installed name matches its declaration. PyPI dependency
updates are not supported.

## conda-lock inputs

Project-root `conda-lock.yml` and `conda-lock.yaml` inputs require
[conda-lockfiles](https://github.com/conda/conda-lockfiles) 0.2 or
newer in the configured conda base environment. Follow the
[conda-lockfiles installation instructions](https://conda.github.io/conda-lockfiles/#installation)
using the channels configured for your conda distribution.

## SBOM export

**Conda Code: Export Environment SBOM** requires
[conda-sboms](https://github.com/conda-incubator/conda-sboms) 0.3.0 or newer in
the conda installation that owns the selected environment. Workspace
environments use the configured primary conda installation.

**Conda Code: Export Workspace Lockfile SBOM** requires conda-workspaces 0.9 or
newer and conda-sboms 0.3.0 or newer in the configured primary conda
installation. The workspace action reads exact package records from
`conda.lock`, so it does not require an installed environment.

(source-build)=

## Source build

Building the VSIX requires the Node.js release in `.nvmrc` and the locked npm
dependencies:

```console
npm ci
npm run vsix
```
