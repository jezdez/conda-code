<h1 align="center">Conda Code</h1>

<p align="center">
  <strong>Conda environments, workspaces, packages, and tasks for Visual Studio Code.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code">
    <img
      src="https://img.shields.io/visual-studio-marketplace/v/jezdez.conda-code?label=Marketplace&amp;color=44A833"
      alt="Visual Studio Marketplace version"
    >
  </a>
  <a href="https://jezdez.github.io/conda-code/">
    <img
      src="https://github.com/jezdez/conda-code/actions/workflows/docs.yml/badge.svg"
      alt="Documentation build"
    >
  </a>
</p>

Conda Code adds its own conda environment and package manager to the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).
It discovers regular environments across local conda installations and
integrates [conda-workspaces](https://github.com/conda-incubator/conda-workspaces)
project environments and tasks in the same provider.

## Get started

1. Install
   [Conda Code from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jezdez.conda-code)
   or run:

   ```console
   code --install-extension jezdez.conda-code
   ```

   Python Environments is installed as an extension dependency.

2. Make Conda Code the default conda manager in your user or workspace
   settings:

   ```json
   {
     "python-envs.defaultEnvManager": "jezdez.conda-code:conda",
     "python-envs.defaultPackageManager": "jezdez.conda-code:conda"
   }
   ```

3. Open the Python Environments view and choose **Conda Code**.

> **Note:** Python Environments currently registers its built-in conda provider
> unconditionally and does not deduplicate environments across providers. Both
> conda branches can appear. The settings above select Conda Code for creation
> and package operations.

Follow the [quickstart](https://jezdez.github.io/conda-code/quickstart/) to
check regular environment and workspace discovery.

## What Conda Code handles

- **Regular environments:** Find base, named, and prefix environments without
  starting their Python interpreters, including environments without Python.
- **Creation inputs:** Create named environments from package specifications,
  `environment.yml`, [CEP 23](https://conda.org/learn/ceps/cep-0023/) explicit
  files, and [conda-lockfiles](https://github.com/conda/conda-lockfiles).
- **conda workspaces:** Discover, install, and manage conda-workspaces
  environments, then run declared tasks through the native VS Code task
  interface.
- **Owner-aware operations:** Route activation, package changes, and safe
  deletion through the conda installation that owns each prefix.
- **Ecosystem compatibility:** Include
  [conda-pypi](https://github.com/conda/conda-pypi) package records, ignore
  [conda-global](https://github.com/conda-incubator/conda-global) tool prefixes,
  and leave Pixi projects to
  [Pixi Code](https://marketplace.visualstudio.com/items?itemName=renan-r-santos.pixi-code)
  when it is installed.

Run **Conda Code: Refresh Environments** after an external change that is not
picked up automatically.

## Requirements

Required:

- Visual Studio Code 1.118 or newer
- conda 26.3 or newer
- A trusted VS Code window for project operations
- A local project registered with Python Environments for project-scoped
  creation and workspace discovery

Optional integrations:

- conda-workspaces 0.7 or newer for workspace environments and tasks
- conda-lockfiles 0.2 or newer for conda lockfile creation inputs
- conda 26.5 or newer for workspace PyPI dependencies

Set `conda-code.condaExecutable` when the primary conda is not available through
`CONDA_EXE`, the Python extension's `python.condaPath` setting, or `PATH`.

See the
[complete requirements](https://jezdez.github.io/conda-code/reference/requirements/)
for installation details.

## Learn more

- [Create environments from project files](https://jezdez.github.io/conda-code/how-to/create-from-files/)
- [Use conda workspaces](https://jezdez.github.io/conda-code/how-to/use-workspaces/)
- [Understand the provider model](https://jezdez.github.io/conda-code/explanation/provider-model/)
- [Troubleshoot Conda Code](https://jezdez.github.io/conda-code/how-to/troubleshooting/)
- [Read the changelog](https://jezdez.github.io/conda-code/changelog/)

Report problems and request features in the
[issue tracker](https://github.com/jezdez/conda-code/issues).

## Development

Use the Node.js release pinned in `.nvmrc`.

```console
npm ci
npm run typecheck
npm test
npm run docs
```

Run the `Extension` launch configuration in an Extension Development Host.
Build an installable package with `npm run vsix`.

## License

Conda Code is distributed under the
[BSD 3-Clause License](https://github.com/jezdez/conda-code/blob/main/LICENSE).
