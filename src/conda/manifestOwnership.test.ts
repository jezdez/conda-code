import assert from 'node:assert/strict';
import test from 'node:test';

import { isPixiProjectManifest } from './manifestOwnership';

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
