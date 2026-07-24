# Coexist with Pixi Code

[Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)
and Conda Code can be installed together.

When Pixi Code is installed, Conda Code:

- ignores `pixi.toml` workspace candidates
- ignores `pyproject.toml` projects with a `[tool.pixi]` table
- excludes prefixes below `.pixi/envs` from regular conda discovery
- refuses to quick-create `conda.toml` in a Pixi project

Conda Code continues to handle `conda.toml` and other conda-workspaces projects.
It does not offer `pixi.lock` as a project creation input.

## Choose a provider per project

Use Pixi Code as the environment manager for Pixi projects and Conda Code for
conda projects. Set the manager through the Python Environments project menu or
through `python-envs.pythonProjects`.

## Move a project from Pixi to conda-workspaces

Remove or rename the Pixi manifest only after completing the project migration.
Add the conda workspace manifest, select Conda Code for the project, then run
**Conda Code: Refresh Environments**.

Do not keep both tools pointed at the same environment prefix. Conda Code hides
a prefix when multiple conda workspace manifests report it, and it always
excludes `.pixi/envs`.
