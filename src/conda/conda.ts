import { dirname, resolve } from 'node:path';

import {
  type CondaInfo,
  type CondaPackageRecord,
  parseCondaInfo,
  parseCondaMutationPrefix,
  parseCondaPackages,
} from './parsers';
import { isRunnableCondaExecutable } from './executable';
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

export interface CondaEnvironmentFileCreateOptions extends CondaClientOperationOptions {
  readonly noDefaultPackages?: boolean;
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

function commandErrorLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const argparseError = lines.find((line) => /:\s*error:\s*/i.test(line));
  const detail = argparseError?.replace(/^.*?:\s*error:\s*/i, '').trim() ?? lines[0];
  return detail === undefined || detail === '' ? undefined : detail.slice(0, 500);
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
  private readonly configuredExecutable: string;
  private readonly maxOutputBytes: number;

  public constructor(options: CondaClientOptions = {}) {
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.configuredExecutable = requireValue(options.condaExecutable ?? 'conda', 'condaExecutable');
    if (!isRunnableCondaExecutable(this.configuredExecutable)) {
      throw new TypeError('condaExecutable must invoke conda directly');
    }
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new RangeError('maxOutputBytes must be a positive safe integer');
    }
  }

  public get executable(): string {
    return this.configuredExecutable;
  }

  public forExecutable(condaExecutable: string): CondaClient {
    const executable = requireValue(condaExecutable, 'condaExecutable');
    if (executable === this.configuredExecutable) {
      return this;
    }
    return new CondaClient({
      runner: this.runner,
      condaExecutable: executable,
      maxOutputBytes: this.maxOutputBytes,
    });
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
    return this.createEnvironment('--name', requireValue(name, 'name'), specs, options);
  }

  public async createPrefixEnvironment(
    prefix: string,
    specs: readonly string[],
    options: CondaClientOperationOptions = {},
  ): Promise<string> {
    return this.createEnvironment('--prefix', requireValue(prefix, 'prefix'), specs, options);
  }

  private async createEnvironment(
    target: '--name' | '--prefix',
    value: string,
    specs: readonly string[],
    options: CondaClientOperationOptions,
  ): Promise<string> {
    const result = await this.runChecked(
      ['create', '--yes', '--json', target, value, '--', ...requireValues(specs, 'specs')],
      options,
    );
    return parseCondaMutationPrefix(result.stdout);
  }

  public async createEnvironmentFromFile(
    file: string,
    name: string,
    options: CondaEnvironmentFileCreateOptions = {},
  ): Promise<string> {
    const environmentFile = resolve(requireValue(file, 'file'));
    const args = [
      'create',
      '--yes',
      '--json',
      '--name',
      requireValue(name, 'name'),
      ...(options.noDefaultPackages === true ? ['--no-default-packages'] : []),
      '--file',
      environmentFile,
    ];
    const result = await this.runChecked(args, options, dirname(environmentFile));
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
    const args = [
      'install',
      '--yes',
      '--json',
      '--prefix',
      requireValue(prefix, 'prefix'),
      options.upgrade === true ? '--update-specs' : '--satisfied-skip-solve',
    ];
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
    const result = await this.runner.run(this.configuredExecutable, args, runOptions);
    if (result.exitCode !== 0) {
      const detail =
        structuredError(result.stdout) ??
        commandErrorLine(result.stderr) ??
        commandErrorLine(result.stdout) ??
        `exit code ${result.exitCode}`;
      throw new Error(`${this.configuredExecutable} failed with ${detail}`);
    }
    return result;
  }
}
