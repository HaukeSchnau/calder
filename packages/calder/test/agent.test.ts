import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Agent from "../src/Agent.ts";

/** Starts a process in its own group, like the agent's workers, and returns its pid. */
const start = (argv: ReadonlyArray<string>) => {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore" });
  child.unref();

  return child.pid!;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe("Agent", () => {
  it.live(
    "stops the workers an earlier run left behind, but not a process that got a recorded pid",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "calder-workers-"));
        const worker = start(["sh", "-c", "sleep 60; :", "worker", "0123456789abcdef"]);
        const other = start(["sleep", "60"]);
        writeFileSync(join(dir, "0123456789abcdef"), String(worker));
        writeFileSync(join(dir, "fedcba9876543210"), String(other));

        yield* Agent.stopLeftovers(dir);
        expect(alive(worker)).toBe(false);
        expect(alive(other)).toBe(true);
        expect(readdirSync(dir)).toEqual([]);
        process.kill(other);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it("takes the pools it is told to, where the host's groups can't say, as on macOS", () => {
    const groups =
      (...pools: ReadonlyArray<string>) =>
      (pool: string) =>
        pools.includes(pool);

    expect(
      Agent.poolsOf({ units: "/run/jobs", sandbox: null, pools: ["pr", "trusted"] }, groups()),
    ).toEqual(["pr", "trusted"]);
    expect(
      Agent.poolsOf({ units: "/run/jobs", sandbox: null, pools: null }, groups("pr", "trusted")),
    ).toEqual(["pr", "trusted"]);
    expect(Agent.poolsOf({ units: "/run/jobs", sandbox: null, pools: null }, groups())).toContain(
      "--units needs",
    );
    expect(Agent.poolsOf({ units: null, sandbox: null, pools: null }, groups("pr"))).toEqual([
      "trusted",
    ]);
    expect(
      Agent.poolsOf({ units: null, sandbox: null, pools: ["pr", "trusted"] }, groups()),
    ).toContain("need --units");
    expect(
      Agent.poolsOf({ units: null, sandbox: null, pools: ["default-branch"] }, groups()),
    ).toContain("need --units");
    // m1 runs both trusted pools' jobs as Hauke, so it takes the default branch's only.
    const m1 = { units: "/run/jobs", sandbox: "calder-job" };
    expect(Agent.poolsOf({ ...m1, pools: ["pr", "default-branch"] }, groups())).toEqual([
      "pr",
      "default-branch",
    ]);
    // Its start script from before, which a Calder that knows the pool must not run.
    expect(Agent.poolsOf({ ...m1, pools: ["pr", "trusted"] }, groups())).toContain(
      "take default-branch instead of trusted",
    );
    expect(Agent.poolsOf({ ...m1, pools: null }, groups("pr", "trusted"))).toContain(
      "take default-branch instead of trusted",
    );
  });

  it("records a worker's pid after the directory was removed", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "calder-workers-")), ".workers");
    Agent.recordPid(dir, "0123456789abcdef", 42);
    rmSync(dir, { recursive: true });
    Agent.recordPid(dir, "fedcba9876543210", 43);
    expect(readFileSync(join(dir, "fedcba9876543210"), "utf8")).toBe("43");
  });
});
