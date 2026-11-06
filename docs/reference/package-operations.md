# Package operations

| Environment                                     | List | Install or add | Update       | Remove         |
| ----------------------------------------------- | ---- | -------------- | ------------ | -------------- |
| Regular conda with a usable owner executable    | Yes  | Yes            | Yes          | Yes            |
| Regular conda without a usable owner executable | Yes  | No             | No           | No             |
| Workspace with conda-workspaces 0.7 metadata    | Yes  | One feature    | No           | No             |
| Workspace with a complete snapshot              | Yes  | Yes            | No           | No             |
| Workspace with structured declaration locations | Yes  | Yes            | Direct conda | Direct package |
| Conflicted workspace prefix                     | No   | No             | No           | No             |

## Regular package records

Conda Code runs `conda list --prefix <prefix> --json --no-pip` and omits records
whose platform is the raw `pypi` marker.

Packages installed through conda-pypi have ordinary conda records and remain
visible. Raw pip-only distributions are not shown.

Regular package mutations use the selected prefix and its owning `conda`
executable:

- install uses `conda install`
- update uses `conda install --update-specs`
- removal uses `conda remove`

Conda Code refuses these mutations when it cannot identify an owning `conda`
executable. The prefix remains available for selection and package listing.

## Workspace package records

Conda Code labels each workspace package as a direct or transitive dependency.
It reuses package records from a complete workspace snapshot when available.
The 0.7-compatible path gets the same records from `conda workspace list`.

Adding packages uses `conda workspace add`. With a complete snapshot, Conda Code
adds to the selected environment's private declaration. With 0.7-compatible
metadata, it targets an environment backed by exactly one feature. Zero-feature
metadata cannot distinguish a default environment from an isolated environment,
and selecting one feature from a composed environment would change other
environments, so both require a complete snapshot.

When conda-workspaces reports a structured declaration location, Conda Code can
remove a direct conda or PyPI dependency and update a direct conda dependency.
It uses the exact environment, feature, and platform selectors from that
location. A shared feature or default declaration prompts for confirmation
because the change can affect other environments. Transitive packages remain
read-only.

Without structured locations, removal and update are refused with instructions
to edit the manifest and refresh Conda Code. PyPI dependency updates are not
supported by `conda workspace update`.

Workspace `[pypi-dependencies]` are handled by conda-workspaces and conda-pypi.
New dependencies entered in Conda Code are conda dependencies. Existing direct
PyPI dependencies can be removed when their declaration location is available.

## Python Environments API

Conda Code uses the published `@vscode/python-environments` 1.4 API. It supplies
`conda-meta/*.json` watch targets so Python Environments can refresh packages
after external conda changes in watched environments. Package reads also support
`skipCache` for an explicit fresh read.

Direct dependency names are available for workspace environments, using their
discovered declarations. Regular environments return no direct-dependency
classification rather than inferring installation intent.

Regular environments with a known owner support package version lookup through
that owner's `conda search`, using its configured channels and search platform.
Versions are deduplicated and sorted newest first using the Python API's PEP 440
representation. An unrepresentable conda version or a failed search reports an
error. Listed versions are not a guarantee that the environment can solve them.
Versioned install specifications use `name==version` for an exact version rather
than conda's single-equals prefix match.

Workspace version lookup is explicitly unsupported: workspace channel and
platform constraints are not yet available to the search implementation.

API callers can pass `runHeadless: true` to manage packages without dialogs or
progress notifications. Changes to shared workspace declarations, including
feature-targeted additions with 0.7 metadata, are rejected in headless mode.
Environment-private changes remain available. Empty package requests do nothing.

Interactive changes to shared declarations, including legacy feature-targeted
additions, require confirmation. Mutation targets are checked before removing any
packages. If a command fails after making partial changes, Conda Code invalidates
cached results and attempts to refresh the package view without hiding the
original error.

Overlapping package reads can finish normally, but only the latest read can
update the cache or publish events. Reads invalidated by cache clearing or
provider disposal are rejected. Ownership is checked again after asynchronous
refreshes and before mutations.

Multi-command mutations recheck ownership and routing before each write. If the
provider is disposed or its target changes while a command runs, no subsequent
write starts. The already-running command is not rolled back; partial changes
are handled by the normal failure-reconciliation path.
