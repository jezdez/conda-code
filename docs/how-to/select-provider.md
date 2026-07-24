# Select the Conda Code provider

The Conda Code environment manager and package manager use the same ID:
`jezdez.conda-code:conda`.

## Make Conda Code the default

Set both Python Environments defaults:

```json
{
  "python-envs.defaultEnvManager": "jezdez.conda-code:conda",
  "python-envs.defaultPackageManager": "jezdez.conda-code:conda"
}
```

These settings control new environment and package operations. They do not hide
other registered managers.

## Select Conda Code for one project

Use **Set Environment Manager** and **Set Package Manager** on the project in
the Python Environments view.

You can also configure the project entry directly:

```json
{
  "python-envs.pythonProjects": [
    {
      "path": "/absolute/path/to/project",
      "envManager": "jezdez.conda-code:conda",
      "packageManager": "jezdez.conda-code:conda"
    }
  ]
}
```

Keep the path aligned with the project registered in Python Environments.
Conda Code only discovers workspace manifests at registered Python project
roots.

## Confirm the selection

Open the Python Environments view and expand **Conda Code**. Run
**Conda Code: Refresh Environments** after changing project registration or
settings.
