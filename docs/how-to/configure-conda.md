# Configure the conda executable

Set `conda-code.condaExecutable` when Conda Code should use a specific conda
installation:

```json
{
  "conda-code.condaExecutable": "/opt/conda/bin/conda"
}
```

On Windows, use the full path to `conda.exe`:

```json
{
  "conda-code.condaExecutable": "C:\\Users\\me\\miniforge3\\Scripts\\conda.exe"
}
```

When the setting is empty, Conda Code checks these sources in order:

1. `CONDA_EXE`
2. `python.condaPath`
3. `conda` on `PATH`

Changing `conda-code.condaExecutable` or `python.condaPath` restarts the provider
and refreshes its environments.

Verify the chosen executable independently:

```console
/opt/conda/bin/conda info --json
```

For workspace support, the same executable must provide
`conda workspace --help`.
