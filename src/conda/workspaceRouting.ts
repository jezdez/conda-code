import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { PythonEnvironment } from '@vscode/python-environments';
import type { Uri } from 'vscode';

import type { WorkspaceDependency, WorkspacePackage } from './workspaces';

export interface CondaWorkspaceRoute {
  readonly projectUri: Uri;
  readonly manifestUri: Uri;
  readonly environmentName: string;
  readonly features: readonly string[];
  readonly directDependencies: readonly WorkspaceDependency[];
  readonly packages: readonly WorkspacePackage[];
  readonly snapshotAvailable: boolean;
  readonly prefix: string;
  readonly pythonPath: string;
}

export function dependencyFeature(environmentName: string, features: readonly string[]): string {
  const feature = features[0];
  if (feature === undefined || features.length !== 1) {
    throw new Error(
      `Package changes require exactly one feature with conda-workspaces 0.7 metadata. ` +
        `${environmentName} uses ${features.length === 0 ? 'none' : features.join(', ')}`,
    );
  }
  return feature;
}

export interface CondaWorkspaceRouteManager {
  getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined;
  refresh(scope: Uri): Promise<void>;
  invalidateRegularDiscovery(): void;
  getEnvironmentForRoute(route: CondaWorkspaceRoute): PythonEnvironment | undefined;
  getEnvironmentForPrefix(prefix: string): PythonEnvironment | undefined;
  getCondaExecutableForPrefix(prefix: string): string | undefined;
  isConflictedPrefix(prefix: string): boolean;
}

export function reconcileWorkspaceRouteClaims(
  current: ReadonlyMap<string, readonly CondaWorkspaceRoute[]>,
  failedManifests: ReadonlySet<string>,
  previous: ReadonlyMap<string, readonly CondaWorkspaceRoute[]>,
): Map<string, readonly CondaWorkspaceRoute[]> {
  const reconciled = new Map(current);
  for (const manifest of failedManifests) {
    if (!reconciled.has(manifest)) {
      const preserved = previous.get(manifest);
      if (preserved !== undefined) {
        reconciled.set(manifest, preserved);
      }
    }
  }
  return reconciled;
}

export function normalizeEnvironmentPath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return path.win32.normalize(value).toLowerCase();
  }
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function canonicalEnvironmentPath(value: string): string {
  const normalized = normalizeEnvironmentPath(value);
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(normalized)) {
    return normalized;
  }
  const missing: string[] = [];
  let current = normalized;
  for (;;) {
    try {
      return normalizeEnvironmentPath(path.join(realpathSync.native(current), ...missing));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return normalized;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Stores conda-workspaces routing data without adding private fields to public
 * PythonEnvironment objects.
 */
export class CondaWorkspaceRouteRegistry {
  private readonly routesByPrefix = new Map<string, CondaWorkspaceRoute>();
  private readonly conflictedPrefixes = new Set<string>();

  replaceAll(routes: readonly CondaWorkspaceRoute[]): void {
    this.clear();

    const routesByPrefix = new Map<string, CondaWorkspaceRoute[]>();
    for (const route of routes) {
      const prefixKey = canonicalEnvironmentPath(route.prefix);
      const entries = routesByPrefix.get(prefixKey) ?? [];
      entries.push(route);
      routesByPrefix.set(prefixKey, entries);
    }

    for (const [prefixKey, entries] of routesByPrefix) {
      if (entries.length !== 1) {
        this.conflictedPrefixes.add(prefixKey);
        continue;
      }
      const route = entries[0];
      if (route === undefined) {
        continue;
      }
      this.routesByPrefix.set(prefixKey, route);
    }
  }

  getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routesByPrefix.get(canonicalEnvironmentPath(environment.environmentPath.fsPath));
  }

  isConflictedPrefix(prefix: string): boolean {
    return this.conflictedPrefixes.has(canonicalEnvironmentPath(prefix));
  }

  getRouteByContext(context: Uri): CondaWorkspaceRoute | undefined {
    if (context.scheme !== 'file') {
      return undefined;
    }

    const contextKey = canonicalEnvironmentPath(context.fsPath);
    const exact = this.routesByPrefix.get(contextKey);
    if (exact) {
      return exact;
    }

    for (const route of this.routesByPrefix.values()) {
      if (canonicalEnvironmentPath(route.pythonPath) === contextKey) {
        return route;
      }
    }

    return undefined;
  }

  clear(): void {
    this.routesByPrefix.clear();
    this.conflictedPrefixes.clear();
  }
}
