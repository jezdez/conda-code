# Package operations

| Environment                                     | List | Install or add | Update | Remove |
| ----------------------------------------------- | ---- | -------------- | ------ | ------ |
| Regular conda with a usable owner executable    | Yes  | Yes            | Yes    | Yes    |
| Regular conda without a usable owner executable | Yes  | No             | No     | No     |
| Workspace with zero or one feature              | Yes  | Yes            | No     | No     |
| Workspace with multiple features                | Yes  | No             | No     | No     |
| Conflicted workspace prefix                     | No   | No             | No     | No     |

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

Conda Code gets packages from `conda workspace list` and labels each record as a
direct or transitive dependency.

Adding packages uses `conda workspace add`. When an environment has one feature,
Conda Code passes that feature. An environment composed from multiple features
requires a direct manifest edit because the package interface does not provide
enough information to choose a feature.

Workspace package removal and update are not exposed. Edit the manifest, run the
workspace operation, and refresh Conda Code.

Workspace `[pypi-dependencies]` are handled by conda-workspaces and conda-pypi.
Package changes initiated from Conda Code apply to conda dependencies.
