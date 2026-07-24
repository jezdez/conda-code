import { spawn } from 'node:child_process';

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

export class CommandCancelledError extends Error {
  public constructor(executable: string) {
    super(`Command was cancelled: ${executable}`);
    this.name = 'CommandCancelledError';
  }
}

export class CommandOutputLimitError extends Error {
  public constructor(executable: string, stream: 'stdout' | 'stderr', limit: number) {
    super(`${executable} exceeded the ${stream} limit of ${limit} bytes`);
    this.name = 'CommandOutputLimitError';
  }
}

export class CommandSpawnError extends Error {
  public constructor(executable: string, cause: unknown) {
    super(`Unable to start command: ${executable}`, { cause });
    this.name = 'CommandSpawnError';
  }
}

export class CommandTerminatedError extends Error {
  public constructor(executable: string, signal: NodeJS.Signals | null) {
    const detail = signal === null ? 'without an exit code' : `by ${signal}`;
    super(`Command ${executable} terminated ${detail}`);
    this.name = 'CommandTerminatedError';
  }
}

interface BoundedBuffer {
  readonly chunks: Buffer[];
  size: number;
}

function appendBounded(target: BoundedBuffer, chunk: Buffer, limit: number): boolean {
  const remaining = limit - target.size;
  if (remaining > 0) {
    const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    target.chunks.push(accepted);
    target.size += accepted.length;
  }
  return chunk.length <= remaining;
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
      throw new CommandCancelledError(executable);
    }

    return new Promise<CommandResult>((resolve, reject) => {
      const stdout: BoundedBuffer = { chunks: [], size: 0 };
      const stderr: BoundedBuffer = { chunks: [], size: 0 };
      let pendingError: Error | undefined;
      let settled = false;

      const child = spawn(executable, Array.from(args), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const removeAbortListener = (): void => {
        options.signal?.removeEventListener('abort', handleAbort);
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        reject(error);
      };

      const stopFor = (error: Error): void => {
        if (pendingError !== undefined) {
          return;
        }
        pendingError = error;
        child.kill();
      };

      const handleAbort = (): void => {
        stopFor(new CommandCancelledError(executable));
      };

      options.signal?.addEventListener('abort', handleAbort, { once: true });

      child.stdout.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (!appendBounded(stdout, chunk, maxOutputBytes)) {
          stopFor(new CommandOutputLimitError(executable, 'stdout', maxOutputBytes));
        }
      });

      child.stderr.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (!appendBounded(stderr, chunk, maxOutputBytes)) {
          stopFor(new CommandOutputLimitError(executable, 'stderr', maxOutputBytes));
        }
      });

      child.once('error', (error) => {
        rejectOnce(new CommandSpawnError(executable, error));
      });

      child.once('close', (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();

        if (pendingError !== undefined) {
          reject(pendingError);
          return;
        }
        if (exitCode === null) {
          reject(new CommandTerminatedError(executable, signal));
          return;
        }

        resolve({
          exitCode,
          stdout: Buffer.concat(stdout.chunks, stdout.size).toString('utf8'),
          stderr: Buffer.concat(stderr.chunks, stderr.size).toString('utf8'),
        });
      });
    });
  }
}
