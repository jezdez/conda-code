# Configure the `conda` executable

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

Conda Code also accepts
[conda-express](https://github.com/jezdez/conda-express) delegates from this
setting, `CONDA_EXE`, or `python.condaPath`. Use bare `cx` or `cxz` on any
platform. On macOS and Linux, the executable path's basename must be exactly
`cx` or `cxz`. On Windows, it must be exactly `cx.exe` or `cxz.exe`:

```json
{
  "conda-code.condaExecutable": "C:\\Tools\\conda-express\\cxz.exe"
}
```

Conda Code does not search `PATH` for or install these delegates. Invoking one
follows conda-express's normal bootstrap behavior.

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
