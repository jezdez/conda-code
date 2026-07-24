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

## A workspace does not appear

Check all of the following:

- The manifest directory is registered as a Python project.
- `conda workspace info --json` succeeds for the manifest.
- The environment is installed.
- The manifest is not a Pixi project ignored because Pixi Code is installed.
- No other workspace manifest reports the same prefix.

Only installed workspace environments appear. Use **Python Envs: Create
Environment** to install a declared environment.

## A workspace prefix disappears

When two workspace manifests report the same prefix, Conda Code hides that
prefix and refuses changes. Change one manifest so that each prefix has one
reporting workspace, then refresh.

## Package changes are refused

Workspace package removal and upgrade require direct manifest edits. Dependency
addition is also refused for an environment composed from multiple features.
See [](use-workspaces.md).

## Quick Create reports multiple project inputs

The project root contains more than one recognized environment input. Run
**Python Envs: Create Environment** and choose one, or remove the inputs that do
not apply.

An existing discovered conda workspace takes precedence and does not use these
files.

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
