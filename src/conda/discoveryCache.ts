import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const FINGERPRINT_BATCH_SIZE = 32;

function metadataValue(metadata: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}): readonly number[] {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.mtimeMs, metadata.size];
}

async function pathFingerprint(value: string): Promise<readonly unknown[]> {
  const normalized = path.normalize(path.resolve(value));
  let link;
  try {
    link = await lstat(normalized);
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'unavailable';
    return [normalized, code];
  }
  if (!link.isSymbolicLink()) {
    return [normalized, metadataValue(link)];
  }
  try {
    const [target, resolved] = await Promise.all([stat(normalized), realpath(normalized)]);
    return [normalized, metadataValue(link), metadataValue(target), resolved];
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'unavailable';
    return [normalized, metadataValue(link), code];
  }
}

export async function fingerprintDiscoveryPaths(paths: readonly string[]): Promise<string> {
  const unique = [...new Set(paths.map((value) => path.normalize(path.resolve(value))))].sort();
  const entries: (readonly unknown[])[] = [];
  for (let index = 0; index < unique.length; index += FINGERPRINT_BATCH_SIZE) {
    entries.push(
      ...(await Promise.all(
        unique.slice(index, index + FINGERPRINT_BATCH_SIZE).map(pathFingerprint),
      )),
    );
  }
  return JSON.stringify(entries);
}
