import assert from 'node:assert/strict';
import test from 'node:test';

import { isCondaWorkspaceManifest, isPixiProjectManifest } from './manifestOwnership';

test('Pixi ownership is limited to Pixi manifests', () => {
  assert.equal(isPixiProjectManifest('/work/pixi.toml'), true);
  assert.equal(isPixiProjectManifest('/work/conda.toml'), false);
  assert.equal(
    isPixiProjectManifest(
      '/work/pyproject.toml',
      `
[project]
name = "demo"

[tool.pixi.project]
channels = ["conda-forge"]
`,
    ),
    true,
  );
  assert.equal(
    isPixiProjectManifest(
      '/work/pyproject.toml',
      `
[ tool . pixi . workspace ]
channels = ["conda-forge"]
`,
    ),
    true,
  );
  assert.equal(
    isPixiProjectManifest(
      '/work/pyproject.toml',
      `
[tool.conda-workspaces]
channels = ["conda-forge"]
`,
    ),
    false,
  );
});

test('workspace manifest recognition excludes unrelated pyprojects', () => {
  assert.equal(isCondaWorkspaceManifest('/work/conda.toml'), true);
  assert.equal(isCondaWorkspaceManifest('/work/pixi.toml'), true);
  assert.equal(
    isCondaWorkspaceManifest('/work/pyproject.toml', '[project]\nname = "demo"\n'),
    false,
  );
  assert.equal(
    isCondaWorkspaceManifest(
      '/work/pyproject.toml',
      '[tool.conda.workspace]\nchannels = ["conda-forge"]\n',
    ),
    true,
  );
  assert.equal(
    isCondaWorkspaceManifest(
      '/work/pyproject.toml',
      '[ tool . pixi . workspace ]\nchannels = ["conda-forge"]\n',
    ),
    true,
  );
});
