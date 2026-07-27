# Package operations

| Environment                                      | List | Install or add | Update       | Remove               |
| ------------------------------------------------ | ---- | -------------- | ------------ | -------------------- |
| Regular conda with a usable owner executable     | Yes  | Yes            | Yes          | Yes                  |
| Regular conda without a usable owner executable  | Yes  | No             | No           | No                   |
| Workspace with conda-workspaces 0.7 metadata     | Yes  | One feature    | No           | No                   |
| Workspace with a complete snapshot, no locations | Yes  | Yes            | No           | No                   |
| Workspace with dependency declaration locations  | Yes  | Yes            | Direct conda | Direct conda or PyPI |
| Conflicted workspace prefix                      | No   | No             | No           | No                   |

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

When conda-workspaces reports a dependency's declaration location, Conda Code
can remove a direct conda dependency and update it at that exact environment,
feature, platform, or top-level default declaration. Installing a spec that is
already a direct conda dependency follows this update path even when the caller
did not explicitly request an upgrade. This avoids adding a second,
environment-local declaration that shadows the existing one.

A direct PyPI dependency can be removed when its installed package name matches
the declaration name. It cannot be updated because `conda workspace update`
does not support PyPI dependencies. If conda-pypi translated the dependency to
a different conda record name, Conda Code does not guess the original name and
leaves that package read-only.

Conda Code asks before changing a top-level default or feature declaration
because it can affect other environments. The same applies when those
declarations are platform-qualified. An environment-local declaration does not
need this confirmation. Transitive packages remain read-only.

Without a structured declaration location, removal and update are refused.
Edit the manifest, apply the workspace change, then refresh Conda Code.

Workspace `[pypi-dependencies]` are handled by conda-workspaces and conda-pypi.
New dependencies entered in Conda Code are conda dependencies and are added to
the selected environment's private declaration when a complete snapshot is
available.
