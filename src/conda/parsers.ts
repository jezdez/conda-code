export interface CondaInfo {
  readonly platform: string;
  readonly rootPrefix: string;
  readonly envsDirs: readonly string[];
  readonly defaultPrefix: string;
  readonly activePrefix: string | null;
  readonly envs: readonly string[];
  readonly envsDetails: Readonly<Record<string, CondaEnvironmentDetails>>;
  readonly configFiles?: readonly string[];
  readonly rcPath?: string;
  readonly userRcPath?: string;
  readonly sysRcPath?: string;
}

export interface CondaEnvironmentDetails {
  readonly name: string;
}

export interface CondaPackageRecord {
  readonly name: string;
  readonly version: string;
  readonly build: string;
  readonly channel?: string;
  readonly platform?: string;
}

export interface WorkspaceInfo {
  readonly manifest: string;
  readonly name: string;
}

export interface WorkspaceEnvironment {
  readonly name: string;
  readonly features: readonly string[];
  readonly installed: boolean;
}

export interface WorkspaceEnvironmentInfo {
  readonly name: string;
  readonly prefix: string;
  readonly condaDependencies: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  readonly build: string;
}

export interface WorkspaceDependency {
  readonly name: string;
  readonly pypi: boolean;
  readonly table?: string;
  readonly location?: WorkspaceDependencyLocation;
}

export interface WorkspaceDependencyLocation {
  readonly environment?: string;
  readonly feature?: string;
  readonly platform?: string;
}

export interface WorkspaceSnapshotResolution {
  readonly platform: string;
  readonly subdir: string;
  readonly dependencies: readonly WorkspaceDependency[];
}

export interface WorkspaceSnapshotEnvironment {
  readonly name: string;
  readonly features: readonly string[];
  readonly prefix: string;
  readonly installed: boolean;
  readonly resolutions: readonly WorkspaceSnapshotResolution[];
  readonly packages: readonly WorkspacePackage[];
}

export interface WorkspaceSnapshot extends WorkspaceInfo {
  readonly environments: readonly WorkspaceSnapshotEnvironment[];
}

export interface WorkspaceQuickstartResult {
  readonly environment: string;
  readonly manifest: string | null;
}

export interface WorkspaceTask {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
}

export interface WorkspaceTaskList {
  readonly file: string;
  readonly tasks: readonly WorkspaceTask[];
}

type JsonRecord = Record<string, unknown>;

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${label} did not return valid JSON`, {
      cause,
    });
  }
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function expectStringArray(value: unknown, path: string): readonly string[] {
  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
}

function expectStringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
  const record = expectRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, expectString(item, `${path}.${key}`)]),
  );
}

function parseCondaEnvironmentDetails(
  value: unknown,
): Readonly<Record<string, CondaEnvironmentDetails>> {
  if (value === undefined) {
    return {};
  }

  const details = expectRecord(value, 'conda info.envs_details');
  return Object.fromEntries(
    Object.entries(details).map(([prefix, item]) => {
      const path = `conda info.envs_details.${prefix}`;
      const record = expectRecord(item, path);
      return [prefix, { name: optionalString(record, 'name', path) ?? '' }];
    }),
  );
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, path);
}

function optionalString(record: JsonRecord, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return expectString(value, `${path}.${key}`);
}

function optionalNullableString(record: JsonRecord, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectString(value, `${path}.${key}`);
}

function optionalStringArray(
  record: JsonRecord,
  key: string,
  path: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return expectStringArray(value, `${path}.${key}`);
}

export function parseCondaInfo(text: string): CondaInfo {
  const value = expectRecord(parseJson(text, 'conda info'), 'conda info');
  const configFiles = optionalStringArray(value, 'config_files', 'conda info');
  const rcPath = optionalString(value, 'rc_path', 'conda info');
  const userRcPath = optionalString(value, 'user_rc_path', 'conda info');
  const sysRcPath = optionalString(value, 'sys_rc_path', 'conda info');
  return {
    platform: expectString(value.platform, 'conda info.platform'),
    rootPrefix: expectString(value.root_prefix, 'conda info.root_prefix'),
    envsDirs: expectStringArray(value.envs_dirs, 'conda info.envs_dirs'),
    defaultPrefix: expectString(value.default_prefix, 'conda info.default_prefix'),
    activePrefix: expectNullableString(value.active_prefix, 'conda info.active_prefix'),
    envs: expectStringArray(value.envs, 'conda info.envs'),
    envsDetails: parseCondaEnvironmentDetails(value.envs_details),
    ...(configFiles === undefined ? {} : { configFiles }),
    ...(rcPath === undefined ? {} : { rcPath }),
    ...(userRcPath === undefined ? {} : { userRcPath }),
    ...(sysRcPath === undefined ? {} : { sysRcPath }),
  };
}

export function parseCondaPackages(text: string): readonly CondaPackageRecord[] {
  return expectArray(parseJson(text, 'conda list'), 'conda list').map((item, index) => {
    const path = `conda list[${index}]`;
    const value = expectRecord(item, path);
    const channel = optionalString(value, 'channel', path);
    const platform = optionalString(value, 'platform', path);
    return {
      name: expectString(value.name, `${path}.name`),
      version: expectString(value.version, `${path}.version`),
      build: optionalString(value, 'build_string', path) ?? '',
      ...(channel === undefined ? {} : { channel }),
      ...(platform === undefined ? {} : { platform }),
    };
  });
}

export function parseCondaMutationPrefix(text: string): string {
  const value = expectRecord(parseJson(text, 'conda mutation'), 'conda mutation');
  if (value.prefix !== undefined) {
    return expectString(value.prefix, 'conda mutation.prefix');
  }

  const actions = expectRecord(value.actions, 'conda mutation.actions');
  return expectString(actions.PREFIX, 'conda mutation.actions.PREFIX');
}

export function parseWorkspaceInfo(text: string): WorkspaceInfo {
  const value = expectRecord(parseJson(text, 'conda workspace info'), 'conda workspace info');
  return {
    manifest: expectString(value.manifest, 'conda workspace info.manifest'),
    name: expectString(value.name, 'conda workspace info.name'),
  };
}

export function parseWorkspaceEnvironments(text: string): readonly WorkspaceEnvironment[] {
  return expectArray(parseJson(text, 'conda workspace envs'), 'conda workspace envs').map(
    (item, index) => {
      const path = `conda workspace envs[${index}]`;
      const value = expectRecord(item, path);
      return {
        name: expectString(value.name, `${path}.name`),
        features: expectStringArray(value.features, `${path}.features`),
        installed: expectBoolean(value.installed, `${path}.installed`),
      };
    },
  );
}

export function parseWorkspaceEnvironmentInfo(text: string): WorkspaceEnvironmentInfo {
  const path = 'conda workspace info -e';
  const value = expectRecord(parseJson(text, path), path);
  return {
    name: expectString(value.name, `${path}.name`),
    prefix: expectString(value.prefix, `${path}.prefix`),
    condaDependencies: expectStringRecord(value.conda_dependencies, `${path}.conda_dependencies`),
  };
}

function parseWorkspacePackage(value: unknown, path: string): WorkspacePackage {
  const record = expectRecord(value, path);
  return {
    name: expectString(record.name, `${path}.name`),
    version: expectString(record.version, `${path}.version`),
    build: expectString(record.build, `${path}.build`),
  };
}

export function parseWorkspacePackages(text: string): readonly WorkspacePackage[] {
  return expectArray(parseJson(text, 'conda workspace list'), 'conda workspace list').map(
    (item, index) => parseWorkspacePackage(item, `conda workspace list[${index}]`),
  );
}

function parseSnapshotDependencies(
  value: unknown,
  path: string,
  pypi: boolean,
): WorkspaceDependency[] {
  return Object.entries(expectRecord(value, path)).map(([name, item]) => {
    const dependencyPath = `${path}.${name}`;
    const dependency = expectRecord(item, dependencyPath);
    const provenance = expectRecord(dependency.provenance, `${dependencyPath}.provenance`);
    const rawLocation = provenance.location;
    const location =
      rawLocation === undefined
        ? undefined
        : (() => {
            const locationPath = `${dependencyPath}.provenance.location`;
            const value = expectRecord(rawLocation, locationPath);
            const environment = optionalNullableString(value, 'environment', locationPath);
            const feature = optionalNullableString(value, 'feature', locationPath);
            const platform = optionalNullableString(value, 'platform', locationPath);
            if (environment !== undefined && feature !== undefined) {
              throw new Error(`${locationPath} cannot select both an environment and a feature`);
            }
            return {
              ...(environment === undefined ? {} : { environment }),
              ...(feature === undefined ? {} : { feature }),
              ...(platform === undefined ? {} : { platform }),
            };
          })();
    return {
      name,
      pypi,
      table: expectString(provenance.table, `${dependencyPath}.provenance.table`),
      ...(location === undefined ? {} : { location }),
    };
  });
}

export function parseWorkspaceSnapshot(text: string): WorkspaceSnapshot {
  const path = 'conda workspace info';
  const value = expectRecord(parseJson(text, path), path);
  const environmentDetails = expectArray(value.environment_details, `${path}.environment_details`);
  return {
    manifest: expectString(value.manifest, `${path}.manifest`),
    name: expectString(value.name, `${path}.name`),
    environments: environmentDetails.map((item, environmentIndex) => {
      const environmentPath = `${path}.environment_details[${environmentIndex}]`;
      const environment = expectRecord(item, environmentPath);
      const resolutions = expectArray(
        environment.resolutions,
        `${environmentPath}.resolutions`,
      ).map((resolutionItem, resolutionIndex) => {
        const resolutionPath = `${environmentPath}.resolutions[${resolutionIndex}]`;
        const resolution = expectRecord(resolutionItem, resolutionPath);
        return {
          platform: expectString(resolution.platform, `${resolutionPath}.platform`),
          subdir: expectString(resolution.subdir, `${resolutionPath}.subdir`),
          dependencies: [
            ...parseSnapshotDependencies(
              resolution.conda_dependencies,
              `${resolutionPath}.conda_dependencies`,
              false,
            ),
            ...parseSnapshotDependencies(
              resolution.pypi_dependencies,
              `${resolutionPath}.pypi_dependencies`,
              true,
            ),
          ],
        };
      });
      const packages = expectArray(environment.packages, `${environmentPath}.packages`).map(
        (packageItem, packageIndex) =>
          parseWorkspacePackage(packageItem, `${environmentPath}.packages[${packageIndex}]`),
      );
      return {
        name: expectString(environment.name, `${environmentPath}.name`),
        features: expectStringArray(environment.features, `${environmentPath}.features`),
        prefix: expectString(environment.prefix, `${environmentPath}.prefix`),
        installed: expectBoolean(environment.installed, `${environmentPath}.installed`),
        resolutions,
        packages,
      };
    }),
  };
}

export function parseWorkspaceQuickstartResult(text: string): WorkspaceQuickstartResult {
  const path = 'conda workspace quickstart';
  const value = expectRecord(parseJson(text, path), path);
  return {
    environment: expectString(value.environment, `${path}.environment`),
    manifest: expectNullableString(value.manifest, `${path}.manifest`),
  };
}

export function parseWorkspaceTasks(text: string): WorkspaceTaskList {
  const path = 'conda task list';
  const value = expectRecord(parseJson(text, path), path);
  const tasks = expectRecord(value.tasks, `${path}.tasks`);
  return {
    file: expectString(value.file, `${path}.file`),
    tasks: Object.entries(tasks).map(([key, item]) => {
      const taskPath = `${path}.tasks.${key}`;
      const task = expectRecord(item, taskPath);
      const name = expectString(task.name, `${taskPath}.name`);
      if (name !== key) {
        throw new Error(`${taskPath}.name must match its task key`);
      }
      const description = optionalString(task, 'description', taskPath);
      const source = optionalString(task, 'source', taskPath);
      return {
        name,
        ...(description === undefined ? {} : { description }),
        ...(source === undefined ? {} : { source }),
      };
    }),
  };
}
