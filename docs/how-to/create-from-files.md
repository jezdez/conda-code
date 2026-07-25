# Create from project files

Conda Code recognizes these files at a registered Python project root:

- `environment.yml`
- `environment.yaml`
- `explicit.txt`
- `conda-lock.yml`
- `conda-lock.yaml`

An existing discovered conda workspace takes precedence. Creating an environment
for that project installs one of its declared environments instead.

## Use `environment.yml`

1. Put `environment.yml` or `environment.yaml` at the project root.
2. Run **Python Envs: Create Environment**.
3. Select the file.
4. Enter the environment name.

Quick Create skips the file and name prompts when there is one recognized input.
It derives an available name from the project directory.

Conda Code runs this command from the project root:

```console
conda create --yes --json --name NAME --file environment.yml
```

The command-line name overrides `name` or `prefix` in the
[CEP 24](https://conda.org/learn/ceps/cep-0024/) file. Packages selected during
creation are installed after the file-based environment is created.

The file is not watched or updated. Use regular package management for the
created prefix.

## Use `explicit.txt`

Place a valid [CEP 23](https://conda.org/learn/ceps/cep-0023/) explicit file at
the project root. It must contain the `@EXPLICIT` marker.

Create the environment through Quick Create or select `explicit.txt` during
interactive creation. Conda Code passes `--no-default-packages` so configured
creation defaults cannot change the exact package set.

Do not select additional packages during creation. Conda Code refuses the
operation instead of changing the exact input.

## Use a conda-lock file

Install
[conda-lockfiles](https://github.com/conda/conda-lockfiles) 0.2 or
newer in the configured conda base environment. Follow the
[conda-lockfiles installation instructions](https://conda.github.io/conda-lockfiles/#installation)
using the channels configured for your conda distribution.

Put `conda-lock.yml` or `conda-lock.yaml` at the project root, then create the
environment through Quick Create or interactive creation.

Conda Code treats these as exact inputs. It disables configured default packages
and refuses additional creation packages.

## Choose among several files

Quick Create fails when the project root contains several recognized inputs. Run
**Python Envs: Create Environment** and choose the file to use.

The same interactive menu also offers a conda workspace, a project `.conda`
prefix, and a regular named environment.
