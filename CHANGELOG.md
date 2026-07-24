# Changelog

## 0.2.0

- Expose conda-workspaces tasks through the native VS Code task interface and
  honor the selected Conda Code workspace environment
- Add the official conda logo as the extension icon

## 0.1.1

- Avoid spawning a conda process for every Python environment resolution request

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
- Create regular named environments from project-root `environment.yml`,
  `environment.yaml`, CEP 23 explicit specifications, and conda-lockfiles inputs
- Add MyST and Sphinx Design documentation organized with Diátaxis and published
  through GitHub Pages
- Add secretless, tag-gated GitHub and Visual Studio Marketplace releases
- Add parser, command, environment lifecycle, and package cache tests
