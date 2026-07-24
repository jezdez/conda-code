export interface CondaInfo {
  readonly platform: string;
  readonly condaVersion: string;
  readonly rootPrefix: string;
  readonly condaPrefix: string;
  readonly envsDirs: readonly string[];
  readonly defaultPrefix: string;
  readonly activePrefix: string | null;
  readonly activePrefixName: string | null;
  readonly envs: readonly string[];
  readonly envsDetails: Readonly<Record<string, CondaEnvironmentDetails>>;
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
  readonly version: string;
  readonly description: string;
  readonly channels: readonly string[];
  readonly platforms: readonly string[];
  readonly knownPlatforms: readonly string[];
  readonly environments: readonly string[];
  readonly features: readonly string[];
  readonly lockfileStatus: string;
  readonly lockfileReason?: string;
}

export interface WorkspaceEnvironment {
  readonly name: string;
  readonly features: readonly string[];
  readonly installed: boolean;
}

export interface WorkspaceEnvironmentInfo {
  readonly name: string;
  readonly prefix: string;
  readonly installed: boolean;
  readonly channels: readonly string[];
  readonly platforms: readonly string[];
  readonly channelPriority: string | null;
  readonly condaDependencies: Readonly<Record<string, string>>;
  readonly pypiDependencies: Readonly<Record<string, string>>;
  readonly packageCount?: number;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  readonly build: string;
}

export interface WorkspaceTask {
  readonly name: string;
  readonly command?: string | readonly string[];
  readonly description?: string;
  readonly dependsOn: readonly string[];
  readonly alias: boolean;
  readonly source?: string;
}

export interface WorkspaceTaskList {
  readonly file: string;
  readonly tasks: Readonly<Record<string, WorkspaceTask>>;
}

export interface WorkspaceQuickstartResult {
  readonly workspace: string;
  readonly environment: string;
  readonly manifest: string | null;
  readonly specsAdded: readonly string[];
  readonly shellSpawned: boolean;
}

type JsonRecord = Record<string, unknown>;

export class CondaJsonParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CondaJsonParseError';
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new CondaJsonParseError(`${label} did not return valid JSON`, {
      cause,
    });
  }
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CondaJsonParseError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new CondaJsonParseError(`${path} must be an array`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new CondaJsonParseError(`${path} must be a string`);
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CondaJsonParseError(`${path} must be a boolean`);
  }
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CondaJsonParseError(`${path} must be a finite number`);
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

export function parseCondaInfo(text: string): CondaInfo {
  const value = expectRecord(parseJson(text, 'conda info'), 'conda info');
  return {
    platform: expectString(value.platform, 'conda info.platform'),
    condaVersion: expectString(value.conda_version, 'conda info.conda_version'),
    rootPrefix: expectString(value.root_prefix, 'conda info.root_prefix'),
    condaPrefix: expectString(value.conda_prefix, 'conda info.conda_prefix'),
    envsDirs: expectStringArray(value.envs_dirs, 'conda info.envs_dirs'),
    defaultPrefix: expectString(value.default_prefix, 'conda info.default_prefix'),
    activePrefix: expectNullableString(value.active_prefix, 'conda info.active_prefix'),
    activePrefixName: expectNullableString(
      value.active_prefix_name,
      'conda info.active_prefix_name',
    ),
    envs: expectStringArray(value.envs, 'conda info.envs'),
    envsDetails: parseCondaEnvironmentDetails(value.envs_details),
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
  const result: WorkspaceInfo = {
    manifest: expectString(value.manifest, 'conda workspace info.manifest'),
    name: expectString(value.name, 'conda workspace info.name'),
    version: expectString(value.version, 'conda workspace info.version'),
    description: expectString(value.description, 'conda workspace info.description'),
    channels: expectStringArray(value.channels, 'conda workspace info.channels'),
    platforms: expectStringArray(value.platforms, 'conda workspace info.platforms'),
    knownPlatforms: expectStringArray(
      value.known_platforms,
      'conda workspace info.known_platforms',
    ),
    environments: expectStringArray(value.environments, 'conda workspace info.environments'),
    features: expectStringArray(value.features, 'conda workspace info.features'),
    lockfileStatus: expectString(value.lockfile_status, 'conda workspace info.lockfile_status'),
  };
  const lockfileReason = optionalString(value, 'lockfile_reason', 'conda workspace info');
  return lockfileReason === undefined ? result : { ...result, lockfileReason };
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
  const result: WorkspaceEnvironmentInfo = {
    name: expectString(value.name, `${path}.name`),
    prefix: expectString(value.prefix, `${path}.prefix`),
    installed: expectBoolean(value.installed, `${path}.installed`),
    channels: expectStringArray(value.channels, `${path}.channels`),
    platforms: expectStringArray(value.platforms, `${path}.platforms`),
    channelPriority:
      value.channel_priority === undefined
        ? null
        : expectNullableString(value.channel_priority, `${path}.channel_priority`),
    condaDependencies: expectStringRecord(value.conda_dependencies, `${path}.conda_dependencies`),
    pypiDependencies: expectStringRecord(value.pypi_dependencies, `${path}.pypi_dependencies`),
  };
  if (value.packages_installed === undefined) {
    return result;
  }
  return {
    ...result,
    packageCount: expectNumber(value.packages_installed, `${path}.packages_installed`),
  };
}

export function parseWorkspacePackages(text: string): readonly WorkspacePackage[] {
  return expectArray(parseJson(text, 'conda workspace list'), 'conda workspace list').map(
    (item, index) => {
      const path = `conda workspace list[${index}]`;
      const value = expectRecord(item, path);
      return {
        name: expectString(value.name, `${path}.name`),
        version: expectString(value.version, `${path}.version`),
        build: expectString(value.build, `${path}.build`),
      };
    },
  );
}

export function parseWorkspaceTaskList(text: string): WorkspaceTaskList {
  const path = 'conda task list';
  const value = expectRecord(parseJson(text, path), path);
  const taskValues = expectRecord(value.tasks, `${path}.tasks`);
  const tasks = Object.fromEntries(
    Object.entries(taskValues).map(([key, item]) => {
      const taskPath = `${path}.tasks.${key}`;
      const task = expectRecord(item, taskPath);
      const commandValue = task.cmd;
      let command: string | readonly string[] | undefined;
      if (commandValue !== undefined) {
        command =
          typeof commandValue === 'string'
            ? commandValue
            : expectStringArray(commandValue, `${taskPath}.cmd`);
      }

      const parsed: WorkspaceTask = {
        name: expectString(task.name, `${taskPath}.name`),
        dependsOn:
          task.depends_on === undefined
            ? []
            : expectStringArray(task.depends_on, `${taskPath}.depends_on`),
        alias: task.alias === undefined ? false : expectBoolean(task.alias, `${taskPath}.alias`),
      };
      const description = optionalString(task, 'description', taskPath);
      const source = optionalString(task, 'source', taskPath);
      return [
        key,
        {
          ...parsed,
          ...(command === undefined ? {} : { command }),
          ...(description === undefined ? {} : { description }),
          ...(source === undefined ? {} : { source }),
        },
      ];
    }),
  );

  return {
    file: expectString(value.file, `${path}.file`),
    tasks,
  };
}

export function parseWorkspaceQuickstartResult(text: string): WorkspaceQuickstartResult {
  const path = 'conda workspace quickstart';
  const value = expectRecord(parseJson(text, path), path);
  return {
    workspace: expectString(value.workspace, `${path}.workspace`),
    environment: expectString(value.environment, `${path}.environment`),
    manifest: expectNullableString(value.manifest, `${path}.manifest`),
    specsAdded: expectStringArray(value.specs_added, `${path}.specs_added`),
    shellSpawned: expectBoolean(value.shell_spawned, `${path}.shell_spawned`),
  };
}
