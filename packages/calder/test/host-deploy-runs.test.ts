import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";
import type { PlannedStep } from "../src/Protocol.ts";
import { drive, step } from "./drive.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const system = `/nix/store/${"d".repeat(32)}-nixos-system-tower-26.05`;

const build: PlannedStep = {
  ...step,
  name: "tower",
  kind: "build",
  needs: [],
  detail: "checks.x86_64-linux.tower",
  build: {
    attr: "checks.x86_64-linux.tower",
    drv: `/nix/store/${"e".repeat(32)}-nixos-system-tower-26.05.drv`,
    out: system,
    system: "x86_64-linux",
  },
};

const deploy: PlannedStep = {
  ...step,
  name: "deploy-tower",
  kind: "deploy",
  needs: ["tower"],
  neverReuse: true,
  detail: "tower from tower",
  deploy: {
    host: "tower",
    system: "tower",
    probes: { units: ["sshd.service"], urls: [], withinMs: 180_000 },
  },
};

describe("a host deploy in a run", () => {
  it.live("goes to the host's agent with the store path its build passed with", () =>
    Effect.gen(function* () {
      const { status, jobs, placements, steps } = yield* drive({
        steps: [build, deploy],
        value: (name) => (name === "tower" ? system : null),
      });

      expect(status).toBe("passed");
      expect(jobs).toEqual(["tower", "deploy-tower"]);
      expect(placements.get("deploy-tower")).toEqual({
        remote: true,
        offload: false,
        systems: [],
        host: "tower",
        deploy: { host: "tower", system, probes: deploy.deploy!.probes },
      });
      expect(steps.get("deploy-tower")?.status).toBe("passed");
    }),
  );

  it.live("runs again when the agent lost it, as when the agent restarted in it", () =>
    Effect.gen(function* () {
      let tries = 0;

      const { status, jobs } = yield* drive({
        steps: [build, deploy],
        value: (name) => (name === "tower" ? system : null),
        result: (name) =>
          name === "deploy-tower" && tries++ === 0
            ? { _tag: "Lost", message: "the agent lost the worker" }
            : undefined,
      });

      expect(status).toBe("passed");
      expect(jobs).toEqual(["tower", "deploy-tower", "deploy-tower"]);
    }),
  );
});
