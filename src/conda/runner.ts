import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: RunCommandOptions,
  ): Promise<CommandResult>;
}

interface ExecFileError extends Error {
  readonly code?: number | string | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr?: string | Buffer;
  readonly stdout?: string | Buffer;
}

const execFileAsync = promisify(execFile);

function asText(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : value.toString('utf8');
}

function asExecFileError(value: unknown): ExecFileError | undefined {
  return value instanceof Error ? (value as ExecFileError) : undefined;
}

export class SpawnCommandRunner implements CommandRunner {
  public async run(
    executable: string,
    args: readonly string[],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new RangeError('maxOutputBytes must be a positive safe integer');
    }
    if (options.signal?.aborted) {
      throw new Error(`Command was cancelled: ${executable}`);
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, Array.from(args), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        signal: options.signal,
        maxBuffer: maxOutputBytes,
        encoding: 'utf8',
      });

      return {
        exitCode: 0,
        stdout: asText(stdout),
        stderr: asText(stderr),
      };
    } catch (error) {
      const commandError = asExecFileError(error);

      if (options.signal?.aborted || commandError?.name === 'AbortError') {
        throw new Error(`Command was cancelled: ${executable}`);
      }
      if (commandError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        const stream = commandError.message.startsWith('stderr') ? 'stderr' : 'stdout';
        throw new Error(`${executable} exceeded the ${stream} limit of ${maxOutputBytes} bytes`);
      }
      if (typeof commandError?.code === 'number') {
        return {
          exitCode: commandError.code,
          stdout: asText(commandError.stdout),
          stderr: asText(commandError.stderr),
        };
      }
      if (commandError?.code === null || commandError?.signal != null) {
        const signal = commandError.signal ?? null;
        const detail = signal === null ? 'without an exit code' : `by ${signal}`;
        throw new Error(`Command ${executable} terminated ${detail}`);
      }

      throw new Error(`Unable to start command: ${executable}`, { cause: error });
    }
  }
}
