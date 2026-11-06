# Coexist with Pixi Code

[Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)
and Conda Code can be installed together.

When Pixi Code is installed, Conda Code:

- ignores `pixi.toml` workspace candidates
- ignores `pyproject.toml` workspaces with a `[tool.pixi]` table
- does not publish tasks from either ignored manifest
- excludes prefixes below `.pixi/envs` from regular conda discovery
- refuses to quick-create `conda.toml` in a Pixi workspace

Conda Code continues to handle `conda.toml` and other workspace manifests. It
does not create a workspace from `pixi.lock`.

## Choose a provider per workspace

Use Pixi Code for Pixi workspaces and Conda Code for workspaces managed by
conda-workspaces. Set the environment manager on the corresponding Python
project through its menu or through `python-envs.pythonProjects`.

## Move a workspace from Pixi to conda-workspaces

Remove or rename the Pixi manifest only after completing the workspace
migration. Add a workspace manifest, select Conda Code for the corresponding
Python project, then run
**Conda Code: Refresh Environments**.

Do not keep both tools pointed at the same environment prefix. Conda Code hides
a prefix when multiple workspace manifests report it, and it always
excludes `.pixi/envs`.
