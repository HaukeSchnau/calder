import { describe, expect, it } from "@effect/vitest";
import type { ActiveJob } from "../src/controller/Jobs.ts";
import { workersOf } from "../src/controller/Ui.ts";

const job = (
  id: string,
  fields: {
    readonly run?: string;
    readonly step?: string;
    readonly shard?: number;
    readonly remote?: boolean;
    readonly running?: boolean;
    readonly said?: number;
    readonly plan?: boolean;
    readonly starting?: boolean;
  } = {},
) =>
  ({
    id,
    spec: {
      _tag: fields.plan === true ? "Plan" : "Step",
      run: { id: fields.run ?? "infra-2416" },
      step: fields.step ?? "mbp",
      shard: fields.shard === undefined ? null : { index: fields.shard, count: 2 },
    },
    template: "calder-job-pr",
    remote: fields.remote ?? false,
    running: fields.running ?? true,
    ...(fields.said === undefined ? {} : { said: fields.said }),
    ...(fields.starting === undefined ? {} : { starting: fields.starting }),
  }) as unknown as ActiveJob;

describe("a run's workers", () => {
  it("are its running jobs, each on its agent or in its unit on the controller's host", () => {
    const active = [
      job("dd11110ebd63d712", { said: 41 }),
      job("a1", { step: "test", shard: 1, remote: true }),
      job("b2", { step: "test", shard: 2 }),
      // Waits for an agent: nothing runs it yet.
      job("c3", { step: "m1", remote: true, running: false }),
      // Its agent just lost it.
      job("d4", { step: "srv-1", remote: true }),
      // Its unit waits to start again.
      job("g7", { step: "dev-hauke", starting: true }),
      job("e5", { run: "infra-2417" }),
      job("f6", { plan: true }),
    ];

    const agents = new Map([["a1", "tower"]]);
    const workers = workersOf("infra-2416", active, (id) => agents.get(id), "srv-2", true);

    expect(Object.fromEntries(workers)).toEqual({
      mbp: [
        {
          job: "dd11110ebd63d712",
          agent: false,
          on: "srv-2",
          unit: "calder-job-pr@dd11110ebd63d712.service",
          shard: null,
          said: 41,
        },
      ],
      test: [
        { job: "a1", agent: true, on: "tower", unit: null, shard: 1, said: null },
        {
          job: "b2",
          agent: false,
          on: "srv-2",
          unit: "calder-job-pr@b2.service",
          shard: 2,
          said: null,
        },
      ],
    });

    // A controller that runs its workers as its own processes has no units.
    expect(
      workersOf("infra-2416", active, (id) => agents.get(id), "srv-2", false).get("mbp")?.[0]?.unit,
    ).toBeNull();
  });
});
