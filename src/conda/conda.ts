import {
  type CondaInfo,
  type CondaPackageRecord,
  parseCondaInfo,
  parseCondaMutationPrefix,
  parseCondaPackages,
} from './parsers';
import {
  type CommandResult,
  type CommandRunner,
  DEFAULT_MAX_OUTPUT_BYTES,
  type RunCommandOptions,
  SpawnCommandRunner,
} from './runner';

export type { CondaInfo, CondaPackageRecord } from './parsers';

export interface CondaClientOptions {
  readonly runner?: CommandRunner;
  readonly condaExecutable?: string;
  readonly maxOutputBytes?: number;
}

export interface CondaClientOperationOptions {
  readonly signal?: AbortSignal;
}

export interface CondaInstallOptions extends CondaClientOperationOptions {
  readonly upgrade?: boolean;
}

export class CondaCommandError extends Error {
  public readonly executable: string;
  public readonly args: readonly string[];
  public readonly result: CommandResult;

  public constructor(executable: string, args: readonly string[], result: CommandResult) {
    const detail =
      structuredError(result.stdout) ??
      firstLine(result.stderr) ??
      firstLine(result.stdout) ??
      `exit code ${result.exitCode}`;
    super(`${executable} failed with ${detail}`);
    this.name = 'CondaCommandError';
    this.executable = executable;
    this.args = args;
    this.result = result;
  }
}

function structuredError(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'error']) {
      const detail = record[key];
      if (typeof detail === 'string' && detail.trim() !== '') {
        return detail.trim().slice(0, 500);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim().slice(0, 500);
  return line === '' ? undefined : line;
}

export function requireValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function requireValues(values: readonly string[], label: string): string[] {
  const normalized = values.map((value, index) => requireValue(value, `${label}[${index}]`));
  if (normalized.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

export class CondaClient {
  private readonly runner: CommandRunner;
  private readonly condaExecutable: string;
  private readonly maxOutputBytes: number;

  public constructor(options: CondaClientOptions = {}) {
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.condaExecutable = requireValue(options.condaExecutable ?? 'conda', 'condaExecutable');
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new RangeError('maxOutputBytes must be a positive safe integer');
    }
  }

  public async getInfo(options: CondaClientOperationOptions = {}): Promise<CondaInfo> {
    const result = await this.runChecked(['info', '--json'], options);
    return parseCondaInfo(result.stdout);
  }

  public async listPrefixPackages(
    prefix: string,
    options: CondaClientOperationOptions = {},
  ): Promise<readonly CondaPackageRecord[]> {
    const result = await this.runChecked(
      ['list', '--prefix', requireValue(prefix, 'prefix'), '--json', '--no-pip'],
      options,
    );
    return parseCondaPackages(result.stdout).filter((record) => record.platform !== 'pypi');
  }

  public async createNamedEnvironment(
    name: string,
    specs: readonly string[],
    options: CondaClientOperationOptions = {},
  ): Promise<string> {
    const result = await this.runChecked(
      [
        'create',
        '--yes',
        '--json',
        '--name',
        requireValue(name, 'name'),
        '--',
        ...requireValues(specs, 'specs'),
      ],
      options,
    );
    return parseCondaMutationPrefix(result.stdout);
  }

  public async createPrefixEnvironment(
    prefix: string,
    specs: readonly string[],
    options: CondaClientOperationOptions = {},
  ): Promise<string> {
    const result = await this.runChecked(
      [
        'create',
        '--yes',
        '--json',
        '--prefix',
        requireValue(prefix, 'prefix'),
        '--',
        ...requireValues(specs, 'specs'),
      ],
      options,
    );
    return parseCondaMutationPrefix(result.stdout);
  }

  public async removeEnvironment(
    prefix: string,
    options: CondaClientOperationOptions = {},
  ): Promise<void> {
    await this.runChecked(
      ['remove', '--yes', '--json', '--all', '--prefix', requireValue(prefix, 'prefix')],
      options,
    );
  }

  public async installPackages(
    prefix: string,
    specs: readonly string[],
    options: CondaInstallOptions = {},
  ): Promise<void> {
    const args = ['install', '--yes', '--json', '--prefix', requireValue(prefix, 'prefix')];
    args.push(options.upgrade === true ? '--update-specs' : '--satisfied-skip-solve');
    args.push('--', ...requireValues(specs, 'specs'));
    await this.runChecked(args, options);
  }

  public async removePackages(
    prefix: string,
    packages: readonly string[],
    options: CondaClientOperationOptions = {},
  ): Promise<void> {
    await this.runChecked(
      [
        'remove',
        '--yes',
        '--json',
        '--prefix',
        requireValue(prefix, 'prefix'),
        '--',
        ...requireValues(packages, 'packages'),
      ],
      options,
    );
  }

  protected async runChecked(
    args: readonly string[],
    options: CondaClientOperationOptions,
    cwd?: string,
  ): Promise<CommandResult> {
    const runOptions: RunCommandOptions = {
      signal: options.signal,
      maxOutputBytes: this.maxOutputBytes,
      ...(cwd === undefined ? {} : { cwd }),
    };
    const result = await this.runner.run(this.condaExecutable, args, runOptions);
    if (result.exitCode !== 0) {
      throw new CondaCommandError(this.condaExecutable, args, result);
    }
    return result;
  }
}
