# Conda Code demo fixtures

The `conda-code-demo` fixture drives the main animation in the README and
documentation. It uses a standard `environment.yml` to create a regular named
environment.

The `workspace` fixture drives the secondary animation in the workspace guide.
It contains one workspace, two direct dependencies, and one declared task.

## Record the regular environment flow

Open the standard fixture:

```console
code demos/conda-code-demo
```

Open `environment.yml`, hover over the editor-title plus action until
**Conda Code: Create Environment from File** is visible, then run it. Keep the
native progress notification visible while Conda solves and installs the
environment. Finish on `conda-code-demo` as the selected project environment in
the Python Environments view.

## Run the workspace fixture

Install conda-workspaces beside the conda executable used by Conda Code. Then,
from this repository:

```console
cd demos/workspace
conda workspace install --yes
code .
```

Open the Python Environments view, expand `conda-code-demo`, and expand its
`default` environment. The direct `python` and `rich` dependencies appear
before the transitive packages.

To run the declared task, open `conda.toml`, choose
**Conda Code: Run Workspace Task** from the editor title, then select
`verify-workspace`. The terminal repeats the task name when it completes so the
result is unambiguous.

The channel in `conda.toml` belongs to the fixture. Conda Code uses the channel
configuration declared by each workspace.

## Update the animation

Use a clean Visual Studio Code window with the **Light Modern** theme and record
only that window. Exclude the window shadow and retain the full frame so
right-aligned tooltips are not clipped. The published assets are:

- `docs/_static/conda-code-demo.gif`, a 960 by 600, 6-frame-per-second regular
  environment demo
- `docs/_static/conda-workspace-demo.gif`, a 960 by 600,
  6-frame-per-second workspace demo

For the regular sequence:

1. Start with a standard `environment.yml`.
2. Hover over **Conda Code: Create Environment from File**, then run it.
3. Show the native progress notification while Conda creates the environment.
4. Show the resulting named environment selected in Python Environments.

For the workspace sequence, prepare the environment before recording so the
capture contains no download or solve. Keep it around twelve seconds.

Keep it focused on the task itself:

1. Show `[tasks.verify-workspace]` and its command in `conda.toml`.
2. Hover over the editor-title play action until
   **Conda Code: Run Workspace Task** is visible, then select it.
3. Choose `verify-workspace` from the task picker.
4. Hold on the terminal output through
   `✓ verify-workspace completed`.
