# Explanation

Understand why Conda Code behaves the way it does.

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`stack` Regular environments and workspaces
:link: environment-model
:link-type: doc

One provider presents two environment sources while keeping their mutation
rules intact.
:::

:::{grid-item-card} {octicon}`file-code` Project files, lockfiles, and workspaces
:link: creation-inputs
:link-type: doc

Why project files create regular named environments while workspaces remain
manifest-managed.
:::

:::{grid-item-card} {octicon}`plug` The provider model
:link: provider-model
:link-type: doc

How Conda Code uses the Python Environments API and why another conda branch can
remain visible.
:::

:::{grid-item-card} {octicon}`versions` Ecosystem fit
:link: ecosystem
:link-type: doc

How conda-workspaces, conda-pypi, conda-global, and Pixi Code relate to Conda
Code, including which manifests contribute workspace tasks.
:::

::::

```{toctree}
:hidden:

Regular environments and workspaces <environment-model>
Project files, lockfiles, and workspaces <creation-inputs>
The provider model <provider-model>
Ecosystem fit <ecosystem>
```
