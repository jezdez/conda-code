# The provider model

Python Environments exposes APIs for extensions to register environment and
package managers. Conda Code registers:

- an environment manager for discovery, creation, removal, selection, and
  execution
- a package manager for listing and changing packages

Both use `jezdez.conda-code:conda`.

## Conda Code runs `conda` directly

The provider runs `conda` and `conda workspace` commands through its own
clients. It does not call the built-in conda manager from Python Environments.

Its discovery and mutation paths apply workspace routing, safe removal rules,
conda-global and conda-exec cache exclusion, conda-pypi record handling, and
Pixi Code coexistence.

The configured conda is the primary route for creation, workspaces, tasks, and
plugin features. Discovery can find additional local conda installations.
Existing regular environments retain an owner root and executable when
discovery can determine them. An owning `conda` executable provides conda hook
activation from that root and handles package changes and safe deletion.
Prefixes without an owning `conda` executable remain visible but cannot be
mutated.

## Why two conda managers can appear

Python Environments currently registers `ms-python.python:conda`
unconditionally. The public extension API supports adding managers but does not
provide a supported replacement, hiding, or cross-manager deduplication
mechanism.

As a result, the built-in conda branch and Conda Code can both list a regular
prefix. Selecting `jezdez.conda-code:conda` as the default or project manager
directs creation and package operations to Conda Code. It does not remove the
built-in branch.

For ordinary conda environments, Conda Code follows the built-in manager's Base,
Named, and Prefix classification. Workspace groups and the documented
conda-global, conda-exec, and Pixi exclusions are intentionally outside that
parity.

## One prefix inside Conda Code

Conda Code deduplicates its own regular and workspace discovery by canonical
prefix identity. Filesystem aliases resolve to one prefix. A prefix reported by
one workspace is published once and routed through that workspace. A prefix
reported by several workspace manifests is hidden until the conflict is
resolved.
