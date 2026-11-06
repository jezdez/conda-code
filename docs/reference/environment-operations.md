# Environment operations

## Regular environments

| Environment type          | Discover                        | Create             | Select | Delete |
| ------------------------- | ------------------------------- | ------------------ | ------ | ------ |
| Base environment          | Yes                             | No                 | Yes    | No     |
| Named environment         | Yes                             | Yes                | Yes    | Yes    |
| Project `.conda` prefix   | Yes                             | Interactive only   | Yes    | Yes    |
| Other conda prefix        | Yes when discovered or resolved | Outside Conda Code | Yes    | No     |
| conda installation prefix | Yes when discovered             | Outside Conda Code | Yes    | No     |
| conda-global tool prefix  | No                              | No                 | No     | No     |
| conda-exec cache prefix   | No                              | No                 | No     | No     |
| `.pixi/envs` prefix       | No                              | No                 | No     | No     |

Regular discovery combines these sources:

- the configured executable, its validated installation root, and default
  environment directories
- `~/.conda/environments.txt`
- conda installation roots found through `conda` executables located inside
  them, relevant `CONDA` environment variables, and standard installation
  locations
- prefixes resolved explicitly from a prefix path or Python executable
- cached `conda info --json` details when available

For each known installation, Conda Code inspects the installation root and the
direct children of its environment directories. It does not recursively scan
arbitrary directories.

Ordinary regular discovery is process-free. Unchanged results are reused when
the discovery filesystem fingerprint is unchanged, and overlapping refresh
requests are coalesced. Missing or stale `conda info --json` details are loaded
as optional background enrichment. Conda Code watches the exact configuration
files reported by conda. A live change schedules one forced background
enrichment. A lightweight fingerprint of those files, relevant conda
environment inputs, and the configured executable detects changes made while
VS Code was closed. The 24-hour cache age remains a fallback for sources that
conda had not reported.

Conda Code determines a prefix's owning installation from its installation
layout or `conda-meta/history`. It then applies the same Base, Named, and Prefix
classification used by the Python Environments conda provider for ordinary
conda environments. The owning installation root is Base, environments named
by conda or found directly below an owner's environment directory are Named,
and other owned environments are Prefix. To preserve the Python Environments
view behavior, an ownerless discovered environment with Python also appears
under Named using its directory name.

An owning `conda` executable provides conda hook activation from the owner root
and handles regular package changes and deletion. A prefix without an owning
`conda` executable remains visible and selectable, but Conda Code refuses to
mutate it. The primary configured conda remains the route for creation,
workspaces, tasks, and plugin features.

Workspace environments do not participate in ordinary environment
classification. conda-global tool prefixes, conda-exec cache prefixes, and
Pixi-owned prefixes remain excluded from regular discovery and explicit
resolution.

Project environment files are creation inputs, not discovery inputs. See
[](project-creation.md). After creation, the regular named environment is
visible after discovery finds its prefix.

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

When conda-workspaces provides a complete snapshot, Quick Create adds Python and
other requested packages directly to the selected environment. With the
0.7-compatible metadata, Conda Code can add them only when the environment is
backed by exactly one feature. Metadata from 0.7 cannot distinguish a default
environment from an isolated environment when its feature list is empty, so
zero-feature and composed environments must be edited directly.

CEP 24 inputs supply their own package set and may receive additional creation
packages afterward. Exact inputs refuse additional packages and disable
configured default packages.

## Execution

Regular environments advertise shell activation for Bash, Zsh, POSIX sh, Fish,
PowerShell Core (`pwsh`), Git Bash, and Command Prompt. Other shells use the
absolute Python interpreter.

Workspace environments use the absolute interpreter directly. Conda Code does
not advertise `conda workspace shell` because it opens a nested blocking shell.
