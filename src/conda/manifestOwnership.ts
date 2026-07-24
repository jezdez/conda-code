import path from 'node:path';

export function isPixiProjectManifest(filePath: string, contents?: string): boolean {
  const name = path.basename(filePath).toLocaleLowerCase();
  if (name === 'pixi.toml') {
    return true;
  }
  if (name !== 'pyproject.toml' || contents === undefined) {
    return false;
  }
  return /^\s*\[\s*tool\s*\.\s*pixi(?:\s*\.|\s*\])/m.test(contents);
}
