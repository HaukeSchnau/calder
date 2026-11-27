import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job as JobSpec, JobResult } from "../src/Protocol.ts";
import * as Values from "../src/Values.ts";
import { Job } from "../src/worker/Client.ts";
import * as Deploy from "../src/worker/Deploy.ts";

const old = `/nix/store/${"a".repeat(32)}-nixos-system-tower-old`;
const next = `/nix/store/${"b".repeat(32)}-nixos-system-tower-new`;
const revision = "c".repeat(40);

type Lease =
  | { _tag: "Held"; fence: number }
  | { _tag: "Replaced"; by: number }
  | { _tag: "Stale"; reason: string };

/**
 * The tower with a real switch command, a script that points the host's link at the system it gets, says
 * so, and exits with the code `codes` names for that system: 4 says two units failed, as NixOS's switch
 * does. `active` and `answering` are the units and URLs that pass their probes.
 */
const tower = (options: {
  readonly codes?: Record<string, number>;
  readonly active?: ReadonlyArray<string>;
  readonly answering?: (calls: ReadonlyArray<string>) => ReadonlyArray<string>;
  readonly lease?: Lease;
  readonly fence?: number;
  readonly runs?: string;
  readonly realise?: Effect.Effect<void, string>;
  /** Whether the controller answers the worker, by the systems the switch got so far. */
  readonly reaches?: (calls: ReadonlyArray<string>) => boolean;
  /** What an earlier attempt that didn't end recorded: the system it deployed and the one before. */
  readonly pending?: readonly [string, string];
  /** What the system profile names at first, when it isn't what the host runs. */
  readonly profile?: string;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "calder-host-deploy-"));
  const link = join(dir, "current");
  const profile = join(dir, "profile");
  symlinkSync(options.runs ?? old, link);
  symlinkSync(options.profile ?? options.runs ?? old, profile);

  for (const [system, code] of Object.entries(options.codes ?? {}))
    writeFileSync(join(dir, `code-${system.slice(-3)}`), String(code));

  const script = join(dir, "switch");

  writeFileSync(
    script,
    `#!/bin/sh
echo "$1" >> ${dir}/calls
ln -sfn "$1" ${link}
ln -sfn "$1" ${profile}
echo "activating $1"
code=$(cat ${dir}/code-$(printf %s "$1" | tail -c 3) 2>/dev/null || echo 0)
if [ "$code" = 4 ]; then echo "warning: the following units failed: backup.service, fleet-links.service" >&2; fi
exit "$code"
`,
  );
  chmodSync(script, 0o755);

  const switched = () => {
    try {
      return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };

  // What the switch got, kept once the deploy ended and took its directory with it.
  let kept: ReadonlyArray<string> = [];
  const calls = () => kept;

  if (options.fence !== undefined) writeFileSync(join(dir, "fence"), String(options.fence));

  if (options.pending !== undefined)
    writeFileSync(join(dir, "pending"), options.pending.join("\n"));
  let pendingLeft = false;

  const host: Deploy.Host = {
    name: "tower",
    switch: script,
    running: () => readlinkSync(link),
    profile: () => readlinkSync(profile),
    state: dir,
    realise: () => options.realise ?? Effect.void,
    active: (unit) => Effect.succeed((options.active ?? []).includes(unit)),
    answers: (url) => Effect.succeed((options.answering?.(switched()) ?? []).includes(url)),
    reaches: Effect.sync(() => options.reaches === undefined || options.reaches(switched())),
  };

  const rpc: Array<string> = [];
  const log: Array<string> = [];

  const client = {
    fleetAcquire: () =>
      Effect.sync(() => rpc.push("acquire")).pipe(
        Effect.as({
          ...(options.lease ?? { _tag: "Held", fence: 9 }),
          targets: [],
          unreachable: [],
        }),
      ),
    fleetRelease: () => Effect.sync(() => void rpc.push("release")),
    gitHead: () => Effect.succeed(revision),
    cachePublish: ({ path }: { readonly path: string }) =>
      Effect.sync(() => void rpc.push(`publish ${path}`)),
  };

  const self = {
    id: "job",
    token: "token",
    remote: { url: "http://controller", workspaces: dir },
    client,
    emit: () => Effect.void,
    log: (_stream: string, text: string) => Effect.sync(() => void log.push(text)),
    flush: Effect.void,
  } as unknown as Job["Service"];

  const job = {
    step: "deploy-tower",
    run: { project: "infra", revision, branch: "main", event: { _tag: "Push", branch: "main" } },
  } as unknown as Extract<JobSpec, { _tag: "Step" }>;

  const deploy = (probes: { units?: ReadonlyArray<string>; urls?: ReadonlyArray<string> } = {}) =>
    Deploy.host(
      job,
      {
        host: "tower",
        system: next,
        probes: { units: probes.units ?? [], urls: probes.urls ?? [], withinMs: 300 },
      },
      host,
    ).pipe(
      Effect.provideService(Job, self),
      Effect.provide(BunServices.layer),
      Effect.ensuring(
        Effect.sync(() => {
          kept = switched();
          pendingLeft = existsSync(join(dir, "pending"));
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );

  return { deploy, calls, rpc, log, pendingLeft: () => pendingLeft };
};

const value = (result: JobResult) =>
  result._tag === "Passed"
    ? Values.decode(result.value)
    : result._tag === "Failed"
      ? Values.decode(result.error)
      : result;

describe("a host deploy on the host's agent", () => {
  it.live("switches through the host's command and reports what it ran before and runs now", () =>
    Effect.gen(function* () {
      const t = tower({
        active: ["calder-agent.service"],
        answering: () => ["https://ci.test/health"],
      });

      const result = yield* t.deploy({
        units: ["calder-agent.service"],
        urls: ["https://ci.test/health"],
      });

      expect(result._tag).toBe("Passed");
      expect(value(result)).toMatchObject({
        host: "tower",
        previous: old,
        current: next,
        healthy: true,
        failedUnits: [],
      });
      expect(t.calls()).toEqual([next]);
      expect(t.rpc).toEqual(["acquire", `publish ${next}`, "release"]);
      expect(t.log).toContain(`activating ${next}`);
    }),
  );

  it.live("reports units the switch left failed that no probe names, and keeps the switch", () =>
    Effect.gen(function* () {
      const t = tower({ codes: { [next]: 4 }, active: ["fleet-links.service"] });
      const result = yield* t.deploy();

      expect(result._tag).toBe("Passed");
      expect(value(result)).toMatchObject({
        current: next,
        failedUnits: ["backup.service", "fleet-links.service"],
      });
      expect(t.calls()).toEqual([next]);
    }),
  );

  it.live("goes back to the system it ran when a probe still fails at its deadline", () =>
    Effect.gen(function* () {
      // The controller's /health answers only while the host runs the old system.
      const t = tower({
        answering: (calls) => (calls.at(-1) === next ? [] : ["https://ci.test/health"]),
      });

      const result = yield* t.deploy({ urls: ["https://ci.test/health"] });

      expect(result._tag).toBe("Failed");
      expect(value(result)).toMatchObject({
        reason: "https://ci.test/health doesn't answer 2xx",
        previous: old,
        current: old,
        rolledBack: true,
      });
      expect(t.calls()).toEqual([next, old]);
    }),
  );

  it.live("goes back when the switch fails, but not for a unit it left failed", () =>
    Effect.gen(function* () {
      const t = tower({ codes: { [next]: 1 } });
      const result = yield* t.deploy();

      expect(value(result)).toMatchObject({
        reason: "the switch exited with 1",
        current: old,
        rolledBack: true,
      });
      expect(t.calls()).toEqual([next, old]);
    }),
  );

  it.live("says so when going back fails too", () =>
    Effect.gen(function* () {
      const t = tower({ codes: { [next]: 1, [old]: 1 } });
      const result = yield* t.deploy();

      expect(value(result)).toMatchObject({
        reason: "the switch exited with 1; going back exited with 1",
        rolledBack: false,
      });
    }),
  );

  it.live("only probes a host that already runs the system", () =>
    Effect.gen(function* () {
      const t = tower({ runs: next, active: [] });
      const result = yield* t.deploy({ units: ["calder-agent.service"] });

      expect(value(result)).toMatchObject({
        reason: "calder-agent.service isn't active",
        rolledBack: false,
      });
      expect(t.calls()).toEqual([]);
    }),
  );

  it.live(
    "switches a host that runs the system while its profile names another, as a reboot would undo",
    () =>
      Effect.gen(function* () {
        const t = tower({ runs: next, profile: old });
        const result = yield* t.deploy();

        expect(value(result)).toMatchObject({ current: next, healthy: true });
        expect(t.calls()).toEqual([next]);
      }),
  );

  it.live("doesn't deploy once a newer run took the host's lease", () =>
    Effect.gen(function* () {
      const t = tower({ lease: { _tag: "Replaced", by: 12 } });
      const result = yield* t.deploy();

      expect(result).toEqual({
        _tag: "Skipped",
        reason: "#12 took deploy-tower's deploy lease, so this older run doesn't deploy",
      });
      expect(t.calls()).toEqual([]);
      expect(t.rpc).toEqual(["acquire", "release"]);
    }),
  );

  it.live("refuses a lease older than the newest the host deployed with", () =>
    Effect.gen(function* () {
      const t = tower({ fence: 10, lease: { _tag: "Held", fence: 9 } });
      const result = yield* t.deploy();

      expect(result).toEqual({
        _tag: "Died",
        message: "tower deployed with fence 10 already, newer than this run's 9",
      });
      expect(t.calls()).toEqual([]);
    }),
  );

  it.live("dies without switching when the system can't be realised", () =>
    Effect.gen(function* () {
      const t = tower({ realise: Effect.fail("unable to download") });
      const result = yield* t.deploy();

      expect(result).toEqual({
        _tag: "Died",
        message: `${next} couldn't be realised from the binary cache: unable to download`,
      });
      expect(t.calls()).toEqual([]);
    }),
  );
});

describe("a host deploy that loses the controller or an earlier attempt", () => {
  it.live(
    "goes back when the controller doesn't answer after the switch, as deploy-rs did for SSH",
    () =>
      Effect.gen(function* () {
        const t = tower({ reaches: (calls) => calls.at(-1) !== next });
        const result = yield* t.deploy();

        expect(value(result)).toMatchObject({
          reason: "the controller doesn't answer",
          current: old,
          rolledBack: true,
        });
        expect(t.calls()).toEqual([next, old]);
      }),
  );

  it.live(
    "goes back to what an earlier attempt switched from, though the host runs the system",
    () =>
      Effect.gen(function* () {
        const before = `/nix/store/${"f".repeat(32)}-nixos-system-tower-fst`;
        const t = tower({ runs: next, pending: [next, before], active: [] });
        const result = yield* t.deploy({ units: ["calder-agent.service"] });

        expect(value(result)).toMatchObject({
          previous: before,
          current: before,
          rolledBack: true,
        });
        expect(t.calls()).toEqual([next, before]);
        expect(t.pendingLeft()).toBe(false);
      }),
  );

  it.live("ignores a record of systems the host runs neither of, as after a deploy by hand", () =>
    Effect.gen(function* () {
      const a = `/nix/store/${"g".repeat(32)}-nixos-system-tower-aaa`;
      const b = `/nix/store/${"h".repeat(32)}-nixos-system-tower-bbb`;
      const t = tower({ pending: [a, b], reaches: (calls) => calls.at(-1) !== next });
      const result = yield* t.deploy();

      expect(value(result)).toMatchObject({ previous: old, current: old, rolledBack: true });
      expect(t.calls()).toEqual([next, old]);
    }),
  );

  it.live("keeps the record while going back failed, and drops it once a deploy stands", () =>
    Effect.gen(function* () {
      const failing = tower({ codes: { [next]: 1, [old]: 1 } });
      yield* failing.deploy();
      expect(failing.pendingLeft()).toBe(true);

      const passing = tower({});
      expect((yield* passing.deploy())._tag).toBe("Passed");
      expect(passing.pendingLeft()).toBe(false);
    }),
  );
});

describe("failedUnits", () => {
  it("reads the units switch-to-configuration says failed", () => {
    expect(Deploy.failedUnits("warning: the following units failed: a.service, b.timer")).toEqual([
      "a.service",
      "b.timer",
    ]);
    expect(Deploy.failedUnits("activating the configuration...")).toEqual([]);
  });
});
