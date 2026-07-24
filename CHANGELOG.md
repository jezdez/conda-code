# Changelog

## 0.1.0

- Add a conda environment and package provider
- Add named and prefix environment discovery, creation, scoped selection, and
  execution
- Remove named and project `.conda` environments with base-installation protection
- Add conda-workspaces as a project-aware lifecycle and package overlay
- Exclude the active conda-global tool root and Pixi-owned prefixes
- Refuse ambiguous workspace ownership and stale package mutations
- Add bounded, shell-free conda command execution with option-delimited specs
- Keep raw pip records outside the conda package manager
- Add parser and command construction tests
