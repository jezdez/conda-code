import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function isCondaExecutable(value: string): boolean {
  const basename = value.split(/[\\/]/).at(-1)?.toLowerCase();
  return (
    basename === 'conda' ||
    basename === 'conda.exe' ||
    basename === 'conda.bat' ||
    basename === '_conda' ||
    basename === '_conda.exe'
  );
}

function environmentPath(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.PATH ?? environment.Path ?? environment.path;
}

function splitPaths(value: string | undefined): readonly string[] {
  return value === undefined || value.trim() === ''
    ? []
    : value
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function condaExecutableCandidatePaths(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  if (executable === undefined || executable.trim() === '') {
    return [];
  }
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return [path.normalize(path.resolve(executable))];
  }
  const extensions =
    process.platform === 'win32'
      ? ['', ...splitPaths(environment.PATHEXT).map((item) => item.toLowerCase())]
      : [''];
  const hasExtension = path.extname(executable) !== '';
  return [
    ...new Set(
      splitPaths(environmentPath(environment)).flatMap((directory) =>
        (hasExtension ? [''] : extensions).map((extension) =>
          path.normalize(path.resolve(directory, `${executable}${extension}`)),
        ),
      ),
    ),
  ];
}

export async function locateCondaExecutablePath(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const candidate of condaExecutableCandidatePaths(executable, environment)) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next command candidate.
    }
  }
  return undefined;
}

export async function resolveCondaExecutablePath(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const located = await locateCondaExecutablePath(executable, environment);
  if (located === undefined) {
    return undefined;
  }
  try {
    return path.normalize(await realpath(located));
  } catch {
    return path.normalize(path.resolve(located));
  }
}

export function isRunnableCondaExecutable(
  value: string,
  platform: NodeJS.Platform = /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
    ? 'win32'
    : process.platform,
): boolean {
  const basename = value.split(/[\\/]/).at(-1)?.toLowerCase();
  if (platform === 'win32') {
    return (
      basename === 'conda.exe' ||
      basename === '_conda.exe' ||
      ((basename === 'conda' || basename === '_conda') &&
        !value.includes('/') &&
        !value.includes('\\'))
    );
  }
  return basename === 'conda' || basename === '_conda';
}
