import path from 'node:path';

export function isCondaWorkspaceManifest(filePath: string, contents?: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'conda.toml' || name === 'pixi.toml') {
    return true;
  }
  if (name !== 'pyproject.toml' || contents === undefined) {
    return false;
  }
  return /^\s*\[\s*(['"]?)tool\1\s*\.\s*(['"]?)(?:conda|pixi)\2\s*\.\s*(['"]?)workspace\3(?:\s*\.|\s*\])/m.test(
    contents,
  );
}

export function isPixiProjectManifest(filePath: string, contents?: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'pixi.toml') {
    return true;
  }
  if (name !== 'pyproject.toml' || contents === undefined) {
    return false;
  }
  return /^\s*\[\s*tool\s*\.\s*pixi(?:\s*\.|\s*\])/m.test(contents);
}
