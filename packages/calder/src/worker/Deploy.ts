import { Deploy } from "@calder-ci/core";
import { Cause, Clock, Effect, Exit } from "effect";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Exec from "../Exec.ts";
import type { Job as JobSpec, JobResult, Probes } from "../Protocol.ts";
import * as Values from "../Values.ts";
import { Job, reconnecting } from "./Client.ts";

type StepJob = Extract<JobSpec, { readonly _tag: "Step" }>;

type Spec = NonNullable<StepJob["deploy"]>;

/** The host an agent deploys (`calder agent --deploys <host> --switch <command>`), and how. */
export interface Host {
  readonly name: string;
  /**
   * `<switch> <system>` makes the host run `system` and exits 0, or 4 when it does but some units failed,
   * as NixOS's switch-to-configuration does. It must finish the switch even when the worker that ran it
   * goes away, such as by starting a unit that does it, since the switch may restart what runs the worker.
   */
  readonly switch: string;
  /** The system the host runs, or "" when it runs none. */
  readonly running: () => string;
  /** Where the agent keeps the root of the system it deploys and the last fence it deployed with. */
  readonly state: string;
  /** Makes `system` valid in this host's store, from the binary cache, with a garbage collector root at `root`. */
  readonly realise: (system: string, root: string) => Effect.Effect<void, string, Exec.Spawner>;
  readonly active: (unit: string) => Effect.Effect<boolean, never, Exec.Spawner>;
  /** Whether `url` answers with a 2xx status. */
  readonly answers: (url: string) => Effect.Effect<boolean>;
}

/** The host the agent that started this worker deploys, from what it handed the worker, or why there is none. */
export const thisHost = (env: NodeJS.ProcessEnv = process.env): Host | string => {
  const name = env.CALDER_DEPLOYS;
  const command = env.CALDER_SWITCH;
  const workspaces = env.CALDER_WORKSPACES;

  if (name === undefined || command === undefined || workspaces === undefined)
    return "only an agent that deploys a host (calder agent --deploys --switch) runs host deploys";

  return {
    name,
    switch: command,
    running: () => {
      try {
        return realpathSync("/run/current-system");
      } catch {
        return "";
      }
    },
    state: join(workspaces, ".deploys"),
    realise: (system, root) =>
      Exec.exec(["nix-store", "--realise", system, "--add-root", root]).pipe(
        Effect.mapError((e) => e.message),
        Effect.timeoutOrElse({
          duration: "1 hour",
          orElse: () => Effect.fail("nix-store --realise didn't finish within an hour"),
        }),
        Effect.flatMap((r) =>
          r.exitCode === 0
            ? Effect.void
            : Effect.fail(
                r.stderr.trim().split("\n").slice(-3).join("\n") || `exit code ${r.exitCode}`,
              ),
        ),
      ),
    active: (unit) =>
      Exec.exec(["systemctl", "is-active", "--quiet", unit]).pipe(
        Effect.map((r) => r.exitCode === 0),
        Effect.orElseSucceed(() => false),
      ),
    answers: (url) =>
      Effect.tryPromise(() => fetch(url, { signal: AbortSignal.timeout(10_000) })).pipe(
        Effect.map((response) => response.ok),
        Effect.orElseSucceed(() => false),
      ),
  };
};

const storePath = /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/;

/** Units a switch says it left failed: switch-to-configuration's `warning: the following units failed: a, b`. */
export const failedUnits = (line: string): ReadonlyArray<string> => {
  const match = /the following units failed: (.+)$/.exec(line.trim());

  return match === null ? [] : match[1]!.split(/,\s*/).filter((unit) => unit !== "");
};

/**
 * What of `probes` still fails once they all passed or `withinMs` ran out: each unit that isn't active and
 * each URL that doesn't answer 2xx, asked again every 2 seconds.
 */
export const probe = (host: Host, probes: Probes) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + probes.withinMs;

    while (true) {
      const units = yield* Effect.filter(probes.units, (unit) =>
        Effect.map(host.active(unit), (active) => !active),
      );

      const urls = yield* Effect.filter(probes.urls, (url) =>
        Effect.map(host.answers(url), (answers) => !answers),
      );

      const failing = [
        ...units.map((unit) => `${unit} isn't active`),
        ...urls.map((url) => `${url} doesn't answer 2xx`),
      ];

      const left = deadline - (yield* Clock.currentTimeMillis);

      if (failing.length === 0 || left <= 0) return failing;
      yield* Effect.sleep(Math.min(2_000, left));
    }
  });

/**
 * Deploys `deploy.system` to the host this worker's agent deploys: takes the host's lease, puts the system
 * in the binary cache, realises it with a root, switches, and runs the probes. When the switch exits with
 * anything but 0 or 4, or a probe still fails at its deadline, the host goes back to the system it ran.
 */
export const host = (job: StepJob, deploy: Spec, on: Host | string = thisHost()) =>
  Effect.gen(function* () {
    const self = yield* Job;
    const auth = { job: self.id, token: self.token };
    const log = (text: string) => self.log("calder", text);
    const died = (message: string) => ({ _tag: "Died", message }) satisfies JobResult;

    if (typeof on === "string") return died(on);

    if (on.name !== deploy.host) return died(`this agent deploys ${on.name}, not ${deploy.host}`);

    if (!storePath.test(deploy.system))
      return died(`${deploy.system} is not a store path, so ${deploy.host} can't run it`);

    const skip = (reason: string) =>
      log(reason).pipe(Effect.as({ _tag: "Skipped", reason } satisfies JobResult));

    const lease = yield* Effect.acquireRelease(
      Effect.orDie(reconnecting(self.client.fleetAcquire({ ...auth, project: job.run.project }))),
      () => Effect.orDie(reconnecting(self.client.fleetRelease(auth))),
    );

    if (lease._tag === "Replaced")
      return yield* skip(
        `#${lease.by} took ${job.step}'s deploy lease, so this older run doesn't deploy`,
      );

    if (lease._tag === "Stale") return yield* skip(`${lease.reason}, so this run doesn't deploy`);

    // The host's own record of the newest fence it deployed with refuses a holder the controller replaced.
    mkdirSync(on.state, { recursive: true });
    const fenceFile = join(on.state, "fence");

    const last = (() => {
      try {
        return Number(readFileSync(fenceFile, "utf8"));
      } catch {
        return 0;
      }
    })();

    if (last >= lease.fence)
      return died(
        `${deploy.host} deployed with fence ${last} already, newer than this run's ${lease.fence}`,
      );
    writeFileSync(fenceFile, String(lease.fence));
    yield* log(`holding ${deploy.host}'s deploy lease, fence ${lease.fence}`);

    const published = yield* Effect.exit(
      reconnecting(self.client.cachePublish({ ...auth, path: deploy.system, artifact: "system" })),
    );

    if (Exit.isFailure(published)) {
      const message = Cause.squash(published.cause);

      return died(message instanceof Error ? message.message : String(message));
    }

    if (job.run.branch !== null) {
      const head = yield* Effect.exit(
        reconnecting(self.client.gitHead({ ...auth, branch: job.run.branch })).pipe(
          Effect.timeout("10 seconds"),
        ),
      );

      if (Exit.isSuccess(head) && head.value !== job.run.revision)
        return yield* skip(
          `${job.run.branch} moved on to ${head.value.slice(0, 12)}, so this run doesn't deploy`,
        );
    }

    const previous = on.running();

    const passed = (failed: ReadonlyArray<string>) =>
      ({
        _tag: "Passed",
        value: Values.encode(
          Deploy.Deployed.make({
            host: deploy.host,
            previous,
            current: deploy.system,
            healthy: true,
            failedUnits: [...failed],
          }),
        ),
        outputs: {},
        key: null,
      }) satisfies JobResult;

    const failed = (reason: string, rolledBack: boolean) => {
      const failure = Deploy.DeployFailed.make({
        host: deploy.host,
        previous,
        current: on.running(),
        reason,
        rolledBack,
      });

      return {
        _tag: "Failed",
        error: Values.encode(failure),
        tag: failure._tag,
        message: failure.message,
        key: null,
        outputs: {},
      } satisfies JobResult;
    };

    const probed = Effect.gen(function* () {
      if (deploy.probes.units.length + deploy.probes.urls.length === 0) return [];
      yield* log(
        `probing ${[...deploy.probes.units, ...deploy.probes.urls].join(", ")} for up to ${Math.round(deploy.probes.withinMs / 1000)} s`,
      );

      return yield* probe(on, deploy.probes);
    });

    if (previous === deploy.system) {
      yield* log(`${deploy.host} already runs ${deploy.system}`);
      const failing = yield* probed;

      return failing.length === 0 ? passed([]) : failed(failing.join("; "), false);
    }

    const root = join(on.state, "system");
    yield* log(`realising ${deploy.system}`);
    const realised = yield* Effect.exit(on.realise(deploy.system, root));

    if (Exit.isFailure(realised))
      return died(
        `${deploy.system} couldn't be realised from the binary cache: ${Cause.squash(realised.cause)}`,
      );

    /** Runs the host's switch to `system`: its exit code and the units it says it left failed. */
    const switchTo = (system: string) =>
      Effect.gen(function* () {
        const units: Array<string> = [];
        yield* log(`$ ${on.switch} ${system}`);

        const code = yield* Exec.stream([on.switch, system], {}, (stream, line) =>
          Effect.sync(() => units.push(...failedUnits(line))).pipe(
            Effect.andThen(self.log(stream, line)),
          ),
        ).pipe(
          Effect.catch((error) =>
            log(`${on.switch} didn't run: ${error.message}`).pipe(Effect.as(-1)),
          ),
        );

        return { code, units, runs: on.running() === system };
      });

    const back = (reason: string) =>
      Effect.gen(function* () {
        yield* log(`${reason}; ${deploy.host} goes back to ${previous}`);

        if (previous === "") return failed(`${reason}; ${deploy.host} ran no system before`, false);
        const undone = yield* switchTo(previous);

        return undone.runs && (undone.code === 0 || undone.code === 4)
          ? failed(reason, true)
          : failed(`${reason}; going back exited with ${undone.code}`, false);
      });

    yield* log(`${deploy.host} runs ${previous}; switching to ${deploy.system}`);
    const switched = yield* switchTo(deploy.system);

    if (switched.code !== 0 && switched.code !== 4)
      return yield* back(`the switch exited with ${switched.code}`);

    if (!switched.runs)
      return yield* back(
        `the switch exited with ${switched.code}, but ${deploy.host} runs ${on.running()}`,
      );

    if (switched.units.length > 0)
      yield* log(
        `the switch left ${switched.units.join(", ")} failed; only the probes decide whether the deploy stands`,
      );

    const failing = yield* probed;

    if (failing.length > 0) return yield* back(failing.join("; "));
    yield* log(`${deploy.host} runs ${deploy.system}`);

    return passed(switched.units.filter((unit) => !deploy.probes.units.includes(unit)));
  }).pipe(Effect.scoped);
