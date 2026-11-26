import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { freshTmp, shellRoots } from "../src/worker/Steps.ts";

describe("freshTmp", () => {
  const root = mkdtempSync(join(tmpdir(), "calder-tmp-"));
  const slot = "/var/lib/calder/workspaces/trusted/a-project-with-a-long-name/slot-12";

  it("gives a slot a real directory at a short path, so sockets fit and paths resolve to themselves", () => {
    const tmp = freshTmp(slot, root);
    expect(tmp.length).toBeLessThan(realpathSync(root).length + 20);
    expect(lstatSync(tmp).isDirectory()).toBe(true);
    expect(realpathSync(tmp)).toBe(tmp);
    expect(lstatSync(tmp).mode & 0o777).toBe(0o700);
  });

  it("empties it for each task and keeps slots apart", () => {
    writeFileSync(join(freshTmp(slot, root), "left-over"), "");
    expect(readdirSync(freshTmp(slot, root))).toEqual([]);
    expect(freshTmp(`${slot}0`, root)).not.toBe(freshTmp(slot, root));
  });
});

describe("a job's shell roots", () => {
  it.effect(
    "are a directory of its own beside the slot, gone when the job ends, which also clears what a dead job of the slot left",
    () =>
      Effect.gen(function* () {
        const project = mkdtempSync(join(tmpdir(), "calder-shells-"));
        const shells = join(project, ".shells");
        mkdirSync(join(shells, "slot-1-dead"), { recursive: true });
        mkdirSync(join(shells, "slot-10-busy"), { recursive: true });

        const dir = yield* Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* shellRoots(join(project, "slot-1"));
            expect(dirname(dir)).toBe(shells);
            expect(readdirSync(shells).toSorted()).toEqual([basename(dir), "slot-10-busy"]);

            return dir;
          }),
        );

        expect(existsSync(dir)).toBe(false);
        expect(readdirSync(shells)).toEqual(["slot-10-busy"]);
      }),
  );
});
