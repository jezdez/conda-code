# Create from `environment.yml`

This tutorial creates a regular named conda environment from a project-root
`environment.yml`.

## Before you start

Complete the [](../quickstart.md). Open a local folder named
`conda-code-demo` in VS Code and register it as a Python project.

Make sure no environment with that name already exists:

```console
conda env list
```

## Add the environment file

Create `environment.yml` at the project root:

```yaml
name: ignored-by-conda-code
dependencies:
  - python
  - pytest
```

The file follows
[CEP 24](https://conda.org/learn/ceps/cep-0024/). Conda Code supplies the
environment name itself, so the `name` in the file does not control the created
environment. Conda uses the channels configured for the selected installation.

## Create the environment

1. Open the Python Environments view.
2. Start **Quick Create** for the project.
3. Select **Conda Code** if VS Code asks for an environment manager.

Conda Code finds the single project input and creates a named environment called
`conda-code-demo`. If that name is already used, it adds a numeric suffix.

Inspect the result:

```console
conda list --name conda-code-demo
```

The environment contains Python and pytest from the file.

## Change the installed environment

Open **Manage Packages** for the environment and install `ruff`.

```console
conda list --name conda-code-demo ruff
```

The package is installed in the prefix. `environment.yml` is unchanged.

## What happened

Conda Code ran `conda create --name conda-code-demo --file environment.yml`
from the project root. The file was a one-time creation input. The resulting
environment is an ordinary named conda environment, so later package operations
use regular conda commands.
