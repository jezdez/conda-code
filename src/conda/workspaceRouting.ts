import path from 'node:path';

import type { PythonEnvironment } from '@vscode/python-environments';
import type { Uri } from 'vscode';

export interface CondaWorkspaceRoute {
  readonly projectUri: Uri;
  readonly manifestUri: Uri;
  readonly environmentName: string;
  readonly features: readonly string[];
  readonly directCondaDependencies: readonly string[];
  readonly prefix: string;
  readonly pythonPath: string;
}

export class CompositeWorkspaceEnvironmentError extends Error {
  public constructor(environmentName: string, features: readonly string[]) {
    super(
      `Package changes require a single feature. ${environmentName} uses: ${features.join(', ')}`,
    );
    this.name = 'CompositeWorkspaceEnvironmentError';
  }
}

export function dependencyFeature(
  environmentName: string,
  features: readonly string[],
): string | undefined {
  if (features.length > 1) {
    throw new CompositeWorkspaceEnvironmentError(environmentName, features);
  }
  return features[0];
}

export interface CondaWorkspaceRouteResolver {
  getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined;
}

export interface CondaWorkspaceRouteManager extends CondaWorkspaceRouteResolver {
  refresh(scope: Uri): Promise<void>;
  getEnvironmentForRoute(route: CondaWorkspaceRoute): PythonEnvironment | undefined;
}

export function normalizeEnvironmentPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function projectKey(project: Uri): string {
  return project.toString(true);
}

/**
 * Stores conda-workspaces routing data without adding private fields to public
 * PythonEnvironment objects.
 */
export class CondaWorkspaceRouteRegistry implements CondaWorkspaceRouteResolver {
  private readonly routesByPrefix = new Map<string, CondaWorkspaceRoute>();
  private readonly prefixesByProject = new Map<string, Set<string>>();

  replaceProject(project: Uri, routes: readonly CondaWorkspaceRoute[]): void {
    this.removeProject(project);

    const prefixKeys = new Set<string>();
    for (const route of routes) {
      const prefixKey = normalizeEnvironmentPath(route.prefix);
      this.routesByPrefix.set(prefixKey, route);
      prefixKeys.add(prefixKey);
    }

    this.prefixesByProject.set(projectKey(project), prefixKeys);
  }

  removeProject(project: Uri): void {
    const key = projectKey(project);
    for (const prefixKey of this.prefixesByProject.get(key) ?? []) {
      this.routesByPrefix.delete(prefixKey);
    }
    this.prefixesByProject.delete(key);
  }

  getRoute(environment: PythonEnvironment): CondaWorkspaceRoute | undefined {
    return this.routesByPrefix.get(normalizeEnvironmentPath(environment.environmentPath.fsPath));
  }

  getRouteByPrefix(prefix: string): CondaWorkspaceRoute | undefined {
    return this.routesByPrefix.get(normalizeEnvironmentPath(prefix));
  }

  getRouteByContext(context: Uri): CondaWorkspaceRoute | undefined {
    if (context.scheme !== 'file') {
      return undefined;
    }

    const contextKey = normalizeEnvironmentPath(context.fsPath);
    const exact = this.routesByPrefix.get(contextKey);
    if (exact) {
      return exact;
    }

    for (const route of this.routesByPrefix.values()) {
      if (normalizeEnvironmentPath(route.pythonPath) === contextKey) {
        return route;
      }
    }

    return undefined;
  }

  getProjectRoutes(project: Uri): readonly CondaWorkspaceRoute[] {
    const prefixKeys = this.prefixesByProject.get(projectKey(project));
    if (!prefixKeys) {
      return [];
    }

    return [...prefixKeys]
      .map((prefixKey) => this.routesByPrefix.get(prefixKey))
      .filter((route): route is CondaWorkspaceRoute => route !== undefined);
  }

  clear(): void {
    this.routesByPrefix.clear();
    this.prefixesByProject.clear();
  }
}
