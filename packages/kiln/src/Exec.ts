import { Effect, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Schema.TaggedError<CommandFailed>("kiln/CommandFailed")("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {
  override get message() {
    return `${this.command} exited with ${this.exitCode}: ${this.stderr.trim().split("\n").slice(-5).join("\n")}`
  }
}

export type ExecError = CommandFailed | PlatformError.PlatformError
export type Spawner = ChildProcessSpawner.ChildProcessSpawner
export const SpawnerTag = ChildProcessSpawner.ChildProcessSpawner

export interface Options {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
}

// A child's stdin is a socket unless ignored, and NixOS's bash takes a socket on stdin for sshd and
// resets PATH from /etc/bashrc.
const command = (argv: ReadonlyArray<string>, options: Options) =>
  ChildProcess.make(argv[0]!, argv.slice(1), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
    stdin: options.stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(options.stdin)),
  })

/** Runs a command to completion and returns stdout. Fails with its stderr on a non-zero exit. */
export const run = (argv: ReadonlyArray<string>, options: Options = {}) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(command(argv, options))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) return yield* new CommandFailed({ command: argv.join(" "), exitCode, stderr })
    return stdout
  })).pipe(Effect.withSpan("exec", { attributes: { command: argv.slice(0, 4).join(" ") } }))

/** Like `run`, but returns the exit code and both outputs instead of failing. */
export const exec = (argv: ReadonlyArray<string>, options: Options = {}) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(command(argv, options))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode: exitCode as number }
  }))

/**
 * Runs a command and hands each line of stdout and stderr to `onLine` as it arrives. The command is
 * killed with its process group when the effect is interrupted.
 */
export const stream = (
  argv: ReadonlyArray<string>,
  options: Options,
  onLine: (stream: "stdout" | "stderr", line: string) => Effect.Effect<void>,
) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(argv[0]!, argv.slice(1), {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: false }),
        detached: true,
        stdin: "ignore",
        forceKillAfter: "10 seconds",
      }),
    )
    const lines = (s: Stream.Stream<Uint8Array, unknown>, name: "stdout" | "stderr") =>
      s.pipe(Stream.decodeText, Stream.splitLines, Stream.runForEach((line) => onLine(name, line)))
    const [, , exitCode] = yield* Effect.all([
      lines(handle.stdout, "stdout"),
      lines(handle.stderr, "stderr"),
      handle.exitCode,
    ], { concurrency: "unbounded" })
    return exitCode as number
  }))
