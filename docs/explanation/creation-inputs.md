# Project files, lockfiles, and workspaces

Conda Code supports two roles for project files:

- a one-time input that creates a regular named environment
- a workspace manifest that continues to define an environment

The distinction determines which command changes the environment later.

## One-time environment inputs

An `environment.yml` or `environment.yaml` describes conda requirements using
[CEP 24](https://conda.org/learn/ceps/cep-0024/). Conda Code passes the file to
`conda create` and supplies a name. The command-line name overrides a `name` or
`prefix` in the YAML file.

After creation, Conda Code manages the resulting prefix as a regular named
environment. It does not retain a relationship to the file. Package operations
change the prefix without rewriting the YAML.

This is useful when a repository already carries an environment file but does
not need manifest synchronization inside VS Code.

## Exact inputs

An `explicit.txt` file with the `@EXPLICIT` marker follows
[CEP 23](https://conda.org/learn/ceps/cep-0023/). It identifies exact package
artifacts and does not require a solve.

[conda-lockfiles](https://github.com/conda/conda-lockfiles) adds
support for `conda-lock.yml` and `conda-lock.yaml` through conda's environment
specifier plugin API. Conda Code delegates parsing and installation to `conda`.

The conda-lockfiles plugin can also register `pixi.lock` as an input format.
Conda Code does not discover that filename because Pixi workspaces already have
a provider path through Pixi Code or conda-workspaces.

For both forms, configured default packages or additional creation packages
would change the exact result. Conda Code disables the defaults and refuses the
additional packages.

The created prefix is still a regular named conda environment. Exactness applies
to creation, not to later package operations.

## Workspace manifests

A workspace manifest remains the workspace definition after installation.
Conda Code associates its installed prefixes with that manifest and routes
supported changes through `conda workspace`.

An existing discovered workspace therefore takes precedence over one-time
project inputs. Creation installs an uninstalled workspace declaration instead
of creating a second environment from another file.

## Ambiguous project roots

Quick Create is non-interactive. When several recognized one-time inputs exist,
Conda Code cannot infer which one should win and stops.

Interactive creation lists the files separately and keeps other permitted
creation modes available.
