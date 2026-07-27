# Create from project files

Conda Code recognizes these files at a registered Python project root:

- `environment.yml`
- `environment.yaml`
- `explicit.txt`
- `conda-lock.yml`
- `conda-lock.yaml`

(editor-file-create)=

## Create from the open file

1. Register the file's directory as a Python project.
2. Open the supported file from the project root.
3. Choose the {octicon}`plus` **Conda Code: Create Environment from File**
   action in the editor title.

Conda Code derives an available environment name from the project directory,
creates a regular named environment, and selects it for the project.

:::{tip}
The open file is the input. If the project contains several supported files,
open the one you want and run the action. Conda Code does not ask you to choose
among the other files.
:::

## Use `environment.yml`

Put `environment.yml` or `environment.yaml` at the project root, open it, and run
**Conda Code: Create Environment from File**.

Conda Code runs this command from the project root:

```console
conda create --yes --json --name NAME --file environment.yml
```

The command-line name overrides `name` or `prefix` in the
[CEP 24](https://conda.org/learn/ceps/cep-0024/) file.

The file is not watched or updated. Use regular package management for the
created prefix.

## Use `explicit.txt`

Place a valid [CEP 23](https://conda.org/learn/ceps/cep-0023/) explicit file at
the project root. It must contain the `@EXPLICIT` marker.

Open `explicit.txt` and run **Conda Code: Create Environment from File**. Conda
Code passes `--no-default-packages` so configured creation defaults cannot
change the exact package set.

The editor action does not add packages. The shared Python Environments flow
refuses additional packages instead of changing the exact input.

## Use a conda-lock file

Install
[conda-lockfiles](https://github.com/conda/conda-lockfiles) 0.2 or
newer in the configured conda base environment. Follow the
[conda-lockfiles installation instructions](https://conda.github.io/conda-lockfiles/#installation)
using the channels configured for your conda distribution.

Put `conda-lock.yml` or `conda-lock.yaml` at the project root. Open the file and
run **Conda Code: Create Environment from File**.

Conda Code treats these as exact inputs. It disables configured default packages.
The shared Python Environments flow refuses additional creation packages.

## Use Python Environments creation instead

The shared Python Environments creation flow remains available:

1. Run **Python Envs: Create Environment**.
2. Choose **Conda Code** if VS Code asks for an environment manager.
3. Select the project file.
4. Enter the environment name.

Quick Create uses the only recognized project input and derives an available
name from the project directory. It fails when the project contains several
recognized inputs. Interactive creation lists every recognized input and lets
you choose one.

An existing discovered workspace takes precedence in this shared creation flow.
The interactive menu also offers a workspace, a project `.conda` prefix, and a
regular named environment. Packages selected during interactive creation are
installed after a file-based environment is created.
