import type {
  DidChangeEnvironmentsEventArgs,
  EnvironmentChangeKind,
  Package,
  PackageChangeKind,
  PythonEnvironment,
} from '@vscode/python-environments';

const ENVIRONMENT_ADD = 'add' as EnvironmentChangeKind;
const ENVIRONMENT_REMOVE = 'remove' as EnvironmentChangeKind;
const PACKAGE_ADD = 'add' as PackageChangeKind;
const PACKAGE_REMOVE = 'remove' as PackageChangeKind;

export interface PackageChange {
  readonly kind: PackageChangeKind;
  readonly pkg: Package;
}

export function diffEnvironments(
  previous: readonly PythonEnvironment[],
  current: readonly PythonEnvironment[],
): DidChangeEnvironmentsEventArgs {
  const previousIds = new Set(previous.map((environment) => environment.envId.id));
  const currentIds = new Set(current.map((environment) => environment.envId.id));

  return [
    ...previous
      .filter((environment) => !currentIds.has(environment.envId.id))
      .map((environment) => ({
        kind: ENVIRONMENT_REMOVE,
        environment,
      })),
    ...current
      .filter((environment) => !previousIds.has(environment.envId.id))
      .map((environment) => ({
        kind: ENVIRONMENT_ADD,
        environment,
      })),
  ];
}

function packageFingerprint(pkg: Package): string {
  return JSON.stringify([pkg.name, pkg.version, pkg.description, pkg.tooltip]);
}

export function diffPackages(
  previous: readonly Package[],
  current: readonly Package[],
): PackageChange[] {
  const previousById = new Map(previous.map((pkg) => [pkg.pkgId.id, pkg]));
  const currentById = new Map(current.map((pkg) => [pkg.pkgId.id, pkg]));
  const changes: PackageChange[] = [];

  for (const pkg of previous) {
    const replacement = currentById.get(pkg.pkgId.id);
    if (!replacement || packageFingerprint(pkg) !== packageFingerprint(replacement)) {
      changes.push({ kind: PACKAGE_REMOVE, pkg });
    }
  }

  for (const pkg of current) {
    const replaced = previousById.get(pkg.pkgId.id);
    if (!replaced || packageFingerprint(pkg) !== packageFingerprint(replaced)) {
      changes.push({ kind: PACKAGE_ADD, pkg });
    }
  }

  return changes;
}
