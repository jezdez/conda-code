# Workspace discovery

## Candidate files

Conda Code searches local workspaces for:

1. `conda.toml`
2. `pixi.toml`
3. `pyproject.toml`

The order above is the priority when more than one candidate exists in a
directory. At most one workspace is published for that directory, and only
that selected manifest contributes tasks. See [](workspace-tasks.md).

The search excludes `.git`, `.conda`, `.pixi`, and `node_modules`.

## Project requirement

The candidate directory must be an exact Python project root registered with
Python Environments. A manifest elsewhere in the VS Code window is ignored.

Conda Code validates each candidate with:

```console
conda workspace --file /path/to/manifest info --json
```

Only installed environments are published. A declared but uninstalled
environment becomes available through the environment creation flow.

## Pixi Code rule

When `renan-r-santos.pixi-code` is installed, Conda Code skips:

- every `pixi.toml`
- a `pyproject.toml` containing a `[tool.pixi]` table

`conda.toml` remains eligible.

Skipped manifests contribute neither environments nor tasks.

## Prefix routing

Each published workspace environment records its manifest, project, environment
name, features, direct conda dependencies, prefix, and Python path.

When exactly one manifest reports a prefix, environment and package changes use
workspace commands. When several manifests report the same prefix, Conda Code
hides it and refuses changes.

## Refresh

Conda Code watches:

- `conda.toml`
- `pixi.toml`
- `pyproject.toml`
- `conda.lock`

Changes schedule a refresh. The manual
**Conda Code: Refresh Environments** command clears package data and refreshes
environment and task sources. It also starts forced conda-information
enrichment in the background.
