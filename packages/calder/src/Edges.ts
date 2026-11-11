import { Effect } from "effect"
import * as Exec from "./Exec.ts"

/**
 * Which planned builds each build uses: a build needs another when the other's derivation is in its
 * closure, keeping only direct links (`deps → release → gate`, not also `deps → gate`). Two steps of
 * the same derivation are one build to Nix and get no link.
 */
export const directUses = (
  builds: ReadonlyArray<{ readonly name: string; readonly drv: string }>,
  closures: ReadonlyMap<string, ReadonlySet<string>>,
) => {
  const uses = (a: (typeof builds)[number], b: (typeof builds)[number]) => a.drv !== b.drv && (closures.get(b.name)?.has(a.drv) ?? false)
  const edges = new Map<string, Array<string>>()
  for (const b of builds) {
    const direct = builds.filter((a) => uses(a, b) && !builds.some((c) => c !== a && uses(a, c) && uses(c, b)))
    if (direct.length > 0) edges.set(b.name, direct.map((a) => a.name))
  }
  return edges
}

export const buildEdges = (builds: ReadonlyArray<{ readonly name: string; readonly drv: string }>) =>
  builds.length < 2
    ? Effect.succeed(new Map<string, Array<string>>())
    : Effect.forEach(builds, (b) =>
      Exec.run(["nix-store", "--query", "--requisites", b.drv]).pipe(
        Effect.map((out) => [b.name, new Set(out.split("\n").filter(Boolean))] as const),
        Effect.orElseSucceed(() => [b.name, new Set<string>()] as const),
      ), { concurrency: 4 }).pipe(Effect.map((closures) => directUses(builds, new Map(closures))))
