# Changelog

## Unreleased

- Use the complete conda-workspaces snapshot when available, reducing workspace
  environment discovery to one conda process and reusing its package records
- Route new dependencies to the selected workspace environment when supported
- Keep conda-workspaces 0.7 compatibility when the complete snapshot is
  unavailable
- Refuse ambiguous zero-feature package additions with 0.7 metadata instead of
  changing a declaration an isolated environment may not inherit
- Show a VS Code progress notification while package changes are applied

## 0.5.0

- Create and select regular named environments directly from supported project
  files through an editor-title action with native progress reporting
- Run tasks declared by a confirmed conda-workspaces manifest through an
  editor-title action and native VS Code Tasks
- Mark workspace dependencies as direct or transitive and list direct
  dependencies first
- Add focused light-theme demos for regular environment creation and workspace
  task execution, with clearer documentation of how Conda Code, Python
  Environments, conda-workspaces, and VS Code Tasks fit together

## 0.4.0

- Exclude conda-exec cache prefixes from regular discovery, explicit resolution,
  and workspace routing across `CONDA_EXEC_HOME`, platform-default roots, and
  filesystem aliases
- Refresh the README and GitHub Pages experience with clearer setup guidance,
  navigation, and section landing pages

## 0.3.0

- Discover multiple conda installations, match Base, Named, and Prefix
  classification, load activation hooks from each owning installation, and
  route package changes and safe deletion through each owning `conda` executable
- Keep ordinary regular-environment refresh process-free, reuse unchanged
  filesystem discovery, coalesce overlapping refreshes, and load cached conda
  details through nonblocking background enrichment
- Watch and fingerprint configuration files reported by conda, conda
  environment inputs, and executable identity, then force one coalesced
  background enrichment after changes, with explicit refresh and cache-age
  fallbacks
- Use only owning `conda` executables for operations and keep removal and
  provider exclusions safe across custom environment directories and path
  aliases

## 0.2.1

- Show installed packages under environments with Python Environments 1.36

## 0.2.0

- Expose conda-workspaces tasks through the native VS Code task interface and
  honor the selected Conda Code workspace environment
- Add the official conda logo as the extension icon

## 0.1.1

- Avoid spawning a `conda` process for every Python environment resolution request

## 0.1.0

- Add a conda environment and package provider
- Add named and prefix environment discovery, creation, scoped selection, and
  execution
- Remove named and project `.conda` environments with base-installation protection
- Add conda-workspaces as a project-aware lifecycle and package overlay
- Exclude the active conda-global tool root and Pixi-owned prefixes
- Refuse changes when multiple workspace manifests report the same prefix
- Retain unaffected environments when one workspace environment cannot be inspected
- Add bounded, shell-free `conda` command execution with option-delimited specs
- List conda-pypi records while omitting raw pip records
- Create regular named environments from project-root `environment.yml`,
  `environment.yaml`, CEP 23 explicit specifications, and conda-lockfiles inputs
- Add MyST and Sphinx Design documentation organized with Diátaxis and published
  through GitHub Pages
- Add secretless, tag-gated GitHub and Visual Studio Marketplace releases
- Add parser, command, environment lifecycle, and package cache tests
