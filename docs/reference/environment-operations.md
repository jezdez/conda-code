# Environment operations

## Regular environments

| Environment type          | Discover                      | Create             | Select | Delete |
| ------------------------- | ----------------------------- | ------------------ | ------ | ------ |
| Base environment          | Yes                           | No                 | Yes    | No     |
| Named environment         | Yes                           | Yes                | Yes    | Yes    |
| Project `.conda` prefix   | Yes                           | Interactive only   | Yes    | Yes    |
| Other conda prefix        | Yes when reported or resolved | Outside Conda Code | Yes    | No     |
| Conda installation prefix | Yes when reported             | Outside Conda Code | Yes    | No     |
| conda-global tool prefix  | No                            | No                 | No     | No     |
| `.pixi/envs` prefix       | No                            | No                 | No     | No     |

Regular discovery starts with the root prefix and environment prefixes from
`conda info --json`. Conda Code can also resolve an unregistered prefix from
the prefix path or its Python executable.

Project environment files are creation inputs, not discovery inputs. See
[](project-creation.md). After creation, the regular named environment is
visible when conda reports its prefix.

Environments without Python remain visible with a warning. Conda Code reads
Python version data from `conda-meta` rather than starting the interpreter.

## Workspace environments

| State                                | Discover          | Install through Create | Select                 | Delete         |
| ------------------------------------ | ----------------- | ---------------------- | ---------------------- | -------------- |
| Installed with Python                | Yes               | Already installed      | Declaring project only | Clean prefix   |
| Installed without Python             | Yes, with warning | Already installed      | Declaring project only | Clean prefix   |
| Declared but not installed           | No                | Yes                    | No                     | Not applicable |
| Prefix claimed by multiple manifests | No                | No                     | No                     | No             |

Deleting a workspace environment runs the workspace clean operation. It does
not remove the declaration from the manifest.

## Creation behavior

| Context                                                   | Quick Create                                            | Interactive Create                                          |
| --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Existing conda workspace                                  | Install a declared environment                          | Choose an uninstalled declaration when needed               |
| One recognized project input                              | Create a named environment from it                      | Choose the input, workspace, `.conda`, or named environment |
| Several recognized project inputs                         | Fail                                                    | Choose an input, workspace, `.conda`, or named environment  |
| Registered project without an input                       | Create `conda.toml` and install its default environment | Choose workspace, `.conda`, or named environment            |
| Pixi project without an input when Pixi Code is installed | Refused                                                 | Project `.conda` or named environment                       |
| Global or multiple projects                               | Create an available named environment                   | Create a named environment                                  |

New regular environments created without a project input and new workspaces
include Python unless the requested package list already contains a Python
specification.

For an existing workspace environment backed by zero or one feature, Quick
Create adds Python when its declaration does not contain it. Additional creation
packages use the same feature rule. An environment composed from multiple
features must be edited directly.

CEP 24 inputs supply their own package set and may receive additional creation
packages afterward. Exact inputs refuse additional packages and disable
configured default packages.

## Execution

Regular environments advertise shell activation for Bash, Zsh, POSIX sh, Fish,
PowerShell Core (`pwsh`), Git Bash, and Command Prompt. Other shells use the
absolute Python interpreter.

Workspace environments use the absolute interpreter directly. Conda Code does
not advertise `conda workspace shell` because it opens a nested blocking shell.
