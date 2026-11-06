# Project creation

## Recognized project inputs

Conda Code checks exact filenames at the registered Python project root.

| Filename           | Provider                                                    | Result                    | Additional creation packages |
| ------------------ | ----------------------------------------------------------- | ------------------------- | ---------------------------- |
| `environment.yml`  | conda, [CEP 24](https://conda.org/learn/ceps/cep-0024/)     | Regular named environment | Allowed                      |
| `environment.yaml` | conda, [CEP 24](https://conda.org/learn/ceps/cep-0024/)     | Regular named environment | Allowed                      |
| `explicit.txt`     | conda, [CEP 23](https://conda.org/learn/ceps/cep-0023/)     | Exact named environment   | Refused                      |
| `conda-lock.yml`   | [conda-lockfiles](https://github.com/conda/conda-lockfiles) | Exact named environment   | Refused                      |
| `conda-lock.yaml`  | [conda-lockfiles](https://github.com/conda/conda-lockfiles) | Exact named environment   | Refused                      |

Conda Code lists the conda-lock filenames whenever they are present. Creation
requires conda-lockfiles 0.2 or newer for the configured `conda` executable.

Conda Code does not automatically treat `requirements.txt`, `spec.txt`, or
`pixi.lock` as project creation inputs. `requirements.txt` normally describes
pip packages in Python projects. Pixi workspaces stay with Pixi Code when it is
installed, or with conda-workspaces otherwise.

## Selected file action

**Conda Code: Create Environment from File** accepts one of the exact filenames
above when it is open from the root of a registered local Python project. It
derives an available named environment from the project directory, creates from
that file, and selects the result for the project.

The selected file is authoritative for this action. If several supported files
exist at the project root, the action uses the open file without prompting for
the others. For example, running it from `environment.yml` uses that file even
when `conda-lock.yml` is present.

Nested files, files outside a registered Python project, and other filenames are
refused.

## Python Environments creation precedence

Creation started through Python Environments follows this order:

1. An existing discovered workspace offers its uninstalled environment
   declarations.
2. Quick Create uses the only recognized project input.
3. Without an input, Quick Create creates a `conda.toml` workspace when
   permitted.
4. Global and multi-project creation creates a named environment.

When several recognized project inputs exist, Quick Create fails. Interactive
creation lists every recognized input and lets the user choose.

Interactive project creation also offers:

- a new workspace when permitted
- a regular prefix at `<project>/.conda`
- a regular named environment

The project `.conda` prefix is never selected by Quick Create.

## Naming

The selected file action and Quick Create derive a named environment from the
project directory name. They replace unsupported characters with hyphens and
add `-1`, `-2`, and later suffixes until the name is available.

Interactive creation asks for a name. Names must start with a letter or number
and may contain letters, numbers, dots, underscores, and hyphens. `base`,
`root`, and existing named environments are refused.

For project input files, Conda Code runs:

```console
conda create --yes --json --name NAME --file FILE
```

The working directory is the project root. `--name` overrides a `name` or
`prefix` declared by a CEP 24 file.

## Exact inputs

For `explicit.txt`, `conda-lock.yml`, and `conda-lock.yaml`, Conda Code also
passes `--no-default-packages`. This prevents conda's configured
`create_default_packages` from changing the exact result.

Additional packages supplied by the creation flow are refused for exact inputs.

## File lifecycle

Project input files are used only during creation. Conda Code does not watch,
rewrite, export, or synchronize them. The created environment is subsequently
discovered and managed as a regular named conda environment.
