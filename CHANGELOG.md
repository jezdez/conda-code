# Changelog

## 0.1.0

- Add a conda environment and package provider
- Add named and prefix environment discovery, creation, scoped selection, and
  execution
- Remove named and project `.conda` environments with base-installation protection
- Add conda-workspaces as a project-aware lifecycle and package overlay
- Exclude the active conda-global tool root and Pixi-owned prefixes
- Refuse changes when multiple workspace manifests report the same prefix
- Retain unaffected environments when one workspace environment cannot be inspected
- Add bounded, shell-free conda command execution with option-delimited specs
- List conda-pypi records while omitting raw pip records
- Add parser, command, environment lifecycle, and package cache tests
