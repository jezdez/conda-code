# Package operations

| Environment                        | List | Install or add | Update | Remove |
| ---------------------------------- | ---- | -------------- | ------ | ------ |
| Regular conda                      | Yes  | Yes            | Yes    | Yes    |
| Workspace with zero or one feature | Yes  | Yes            | No     | No     |
| Workspace with multiple features   | Yes  | No             | No     | No     |
| Conflicted workspace prefix        | No   | No             | No     | No     |

## Regular package records

Conda Code runs `conda list --prefix <prefix> --json --no-pip` and omits records
whose platform is the raw `pypi` marker.

Packages installed through conda-pypi have ordinary conda records and remain
visible. Raw pip-only distributions are not shown.

Regular package mutations use the selected prefix:

- install uses `conda install`
- update adds `--update-specs`
- removal uses `conda remove`

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
