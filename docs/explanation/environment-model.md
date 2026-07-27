# Regular environments and workspaces

Conda Code presents regular conda environments and workspace environments
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
commands so changes remain represented by the manifest.
:::

::::

## Core commands and `conda env`

Conda Code reads registration files, installation layouts, and `conda-meta` for
regular discovery. It uses core commands such as `conda create`, `conda list`,
and `conda remove` for operations. The `conda env` command group refers to the
same named and prefix environments, but Conda Code does not use it or define a
separate `conda env` environment type.

The base environment, named environments, and project `.conda` prefixes are all
regular conda prefixes. They contain `conda-meta` package records and can be
inspected with standard `conda` commands.

A project-root `environment.yml`, `environment.yaml`, or supported exact input
can create a regular named environment through Conda Code. The file is used once
and is not kept in sync with the prefix. See [](creation-inputs.md).

## More than one conda installation

A machine can contain several conda installations. Treating every prefix as if
the configured conda owns it can produce the wrong activation hook or mutate it
with the wrong executable.

Conda Code therefore discovers ordinary environments across local conda
installation roots. Discovery starts from the primary conda, registration data,
environment variables, `conda` executables located inside their roots, standard
installation locations, and explicitly resolved prefixes. Conda Code expands
each installation through the direct children of its environment directories.

The installation layout and `conda-meta/history` associate a prefix with an
owner. Only an owning `conda` executable provides conda hook activation and
handles package changes or safe deletion. An arbitrary command recorded in
history cannot become an owner executable. A prefix without an owning `conda`
executable stays visible and uses direct execution, but mutation is refused.

This ownership model also preserves the Base, Named, and Prefix classification
used by the Python Environments conda provider for ordinary environments. It
does not fold workspace environments, conda-global tool prefixes, conda-exec
cache prefixes, or Pixi-owned prefixes into that classification.

The configured conda is still primary. Conda Code uses it for creation,
conda-workspaces, tasks, and plugin features because those operations need one
deliberate command route.

## Refresh behavior

Ordinary regular-environment refresh is process-free. Conda Code reads conda
registration data, known installation roots, environment directories, and
`conda-meta` records without starting `conda` or any environment interpreter.

Conda Code fingerprints those filesystem sources and reuses regular discovery
when they have not changed. Overlapping refresh requests share the active
refresh. Requests arriving during a pass schedule one subsequent pass.

Full `conda info --json` data is optional enrichment. Conda Code caches it and,
when the cache is missing or stale, loads it in the background after the
process-free result is available. This can add nonstandard roots or environment
directories without delaying the initial list.

Conda Code watches the exact configuration files reported by conda. A live
change expires only the conda information and schedules one coalesced background
`conda info --json` request. An explicit refresh forces the same request. The
cache also fingerprints those files, relevant conda environment inputs, and the
configured executable so changes made while VS Code was closed trigger
enrichment on the next refresh. The 24-hour cache age remains a fallback for new
or unknown configuration sources.

Conda Code does not parse configuration YAML or reproduce conda's precedence
rules. Conda remains responsible for merging configuration and returning the
effective `envs_dirs`. Until enrichment succeeds, the last committed
environment snapshot remains available.

Workspace discovery is separate and can run `conda workspace` commands for
workspace manifests registered through Python Environments.

## Why workspaces need a separate route

A workspace prefix is an installed result of a manifest declaration. Changing
only the prefix would leave the declaration and lock data out of sync.

Conda Code therefore associates the installed prefix with the one manifest that
reports it. Package changes and environment cleanup use that association. If
several manifests report the same prefix, Conda Code cannot choose one and does
not publish the environment.

## Why both appear together

The Python Environments view is most useful when a developer can select a
Python environment without first knowing which `conda` command created it.
Conda Code keeps that common selection surface while preserving the distinct
change path behind each environment.
