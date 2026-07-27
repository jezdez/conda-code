# Troubleshoot Conda Code

## Two conda branches appear

Python Environments registers its built-in `ms-python.python:conda` manager
independently. Its public API does not currently let another extension replace
or hide that manager.

Select `jezdez.conda-code:conda` as the default and project manager. See
[](select-provider.md).

## The Conda Code branch is empty

1. Open **View: Output** and select **Conda Code**.
2. Run **Conda Code: Refresh Environments**.
3. Check the configured executable with `conda info --json`.
4. Set `conda-code.condaExecutable` to an absolute path if needed.

Conda Code retains environments without Python, but marks them with a warning.
A prefix without a `conda-meta` directory is not a conda environment and is
ignored.

The configured executable selects the primary conda. Additional
conda installations can be discovered through `~/.conda/environments.txt`,
`conda` executables located inside their roots, relevant conda environment
variables, and standard installation locations.

Initial regular discovery does not wait for `conda info --json`. Conda Code
loads missing or stale conda details in the background and caches the result.
It watches the exact configuration files reported by conda while VS Code is
open and fingerprints those files, relevant conda environment inputs, and the
configured executable across restarts. Run **Conda Code: Refresh Environments**
to force that request after changing a new or unreported configuration source.
The 24-hour cache age is the final fallback where no source or file event was
available.

## An environment cannot be changed

Conda Code keeps a valid prefix visible when it cannot determine an owning `conda`
executable. Selection, package listing, and inspection remain available. Direct
execution remains available when the prefix contains Python. Shell activation,
package changes, and deletion require an owning `conda` executable. Make `conda`
available in the owning installation, then refresh.

## A workspace does not appear

Check all of the following:

- The manifest directory is registered as a Python project.
- `conda workspace info --json` succeeds for the manifest.
- The environment is installed.
- The manifest is not a Pixi workspace ignored because Pixi Code is installed.
- No other workspace manifest reports the same prefix.

Only installed workspace environments appear. Use **Python Envs: Create
Environment** to install a declared environment.

## A workspace prefix disappears

When two workspace manifests report the same prefix, Conda Code hides that
prefix and refuses changes. Change one manifest so that each prefix has one
reporting workspace, then refresh.

## Package changes are refused

Conda Code enables workspace changes only when conda-workspaces reports enough
metadata to preserve the manifest:

- Adding to a composed or zero-feature environment needs a complete snapshot.
- Removal and update need the direct dependency's declaration location.
- PyPI dependencies can be removed, but not updated.
- Transitive dependencies remain read-only.
- A PyPI package remains read-only when conda-pypi gave its installed conda
  record a different name from the manifest declaration.

The 0.7-compatible path can still add to an environment backed by exactly one
feature. See [](use-workspaces.md).

## Quick Create reports multiple project inputs

The project root contains more than one recognized environment input. Run
**Python Envs: Create Environment** and choose one, or remove the inputs that do
not apply.

An existing discovered workspace takes precedence and does not use these files.

## Additional creation packages are refused

`explicit.txt`, `conda-lock.yml`, and `conda-lock.yaml` describe exact package
sets. Conda Code refuses additional creation packages and disables configured
default packages for these inputs.

Add packages after creation only when the environment should diverge from the
exact input.

## A conda-global environment is missing

This is expected. Conda Code excludes the active conda-global tool root because
those prefixes back globally installed commands rather than selectable project
environments.
