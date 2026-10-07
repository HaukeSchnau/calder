// Checked by tsc, not run. Each @ts-expect-error is an error the API must produce.
import { Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { Action, Busy, type Cache, type Fleet, Kiln, On, PullRequest, Step, Task, cmd, type CurrentRun } from "../src/index.ts"
import type { TaskFailed, TimedOut } from "../src/Kiln.ts"
import type { Blocked, Died, Failed, Passed } from "../src/Step.ts"
import { DevController, DevControllerLive, gate, Live, preview, project, promote, promoteRelease, qa, release, Skipped } from "./fixtures.ts"

type Expect<T extends true> = T
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

export type _project = Expect<Equal<typeof project, Kiln.Project>>
export type _promoteA = Expect<Equal<Step.Success<typeof promote>, Live | Skipped>>
export type _promoteR = Expect<Equal<Step.Services<typeof promote>, CurrentRun | Cache>>
export type _qaE = Expect<Equal<Step.Error<typeof qa>, TaskFailed | TimedOut>>
export type _previewR = Expect<Equal<Step.Services<typeof preview>, DevController>>

// Step.exit hands the body the outcome.
Action.make("exit", { needs: { q: Step.exit(qa), all: Step.exits([qa, gate]) } }, function*({ q, all }) {
  type _q = Expect<Equal<typeof q, Passed<void> | Failed<TaskFailed | TimedOut> | Died | Blocked>>
  type _n = Expect<Equal<typeof all.length, 2>>
})

// Plain data is storable; the value type follows the body.
const data = Action.make("data", {}, function*() {
  return { url: "x", n: 1 }
})
export type _data = Expect<Equal<Step.Success<typeof data>, { readonly url: string; readonly n: number }>>

// Only Kiln.Failure errors stay typed.
const failing = Action.make("failing", {}, function*() {
  yield* new Busy({ target: "srv-2" })
  yield* Effect.fail(new Error("plain"))
})
export type _failing = Expect<Equal<Step.Error<typeof failing>, Busy>>

// 1. A value only exists if its step is in needs.
Action.make("promote", { after: [qa], grants: { deploy: true } }, function*() {
  // @ts-expect-error release is a step here, not a store path
  return yield* promoteRelease(release)
})

// 2. Deploying takes a declared grant. Without it, Fleet stays in the step's requirements.
const ungranted = Action.make("ungranted", { needs: { release } }, function*({ release }) {
  return yield* promoteRelease(release)
})
export type _ungranted = Expect<Equal<Step.Services<typeof ungranted>, CurrentRun | Fleet | Cache>>
// @ts-expect-error Fleet is not part of Base
Kiln.project({ rules: [On.push("main", [ungranted])] })

// 3. Pull-request rules don't run steps with grants.
// @ts-expect-error promote has grants
On.pullRequest([promote])

// 4. A service from the project layer has to be provided.
// @ts-expect-error DevController is missing
Kiln.project({ rules: [On.pullRequest([preview])] })
Kiln.project({ layer: DevControllerLive, rules: [On.pullRequest([preview])] })

// 5. Only string or number values can go into a command.
// @ts-expect-error promote's value is a Result
cmd`deploy ${promote}`
const typed = cmd`echo ${release} ${preview} ${"x"} ${1}`
export type _cmdR = Expect<Equal<typeof typed, import("../src/Cmd.ts").Cmd<DevController>>>

// PullRequest is only provided to pull-request rules.
const commenter = Action.make("commenter", {}, function*() {
  yield* PullRequest.comment("hi")
})
Kiln.project({ rules: [On.pullRequest([commenter])] })
// @ts-expect-error trusted rules have no PullRequest
Kiln.project({ rules: [On.push("main", [commenter])] })

// HttpClient is in both bases.
declare const http: Effect.Effect<void, never, HttpClient.HttpClient>
const fetcher = Action.make("fetcher", {}, function*() {
  yield* http
})
Kiln.project({ rules: [On.pullRequest([fetcher]), On.push("main", [fetcher])] })

// Retry keeps outputs; timeout adds TimedOut.
const archive = Task.make("archive", { run: cmd`make`, outputs: { ipa: "build/app.ipa" } })
const retried = archive.pipe(Step.retry({ while: (e) => e.failures.length > 0, times: 1 }), Step.timeout("1 minute"))
export const ipa: Step.Step<Kiln.StorePath, never, never> = retried.outputs.ipa
export type _retried = Expect<Equal<Step.Error<typeof retried>, TaskFailed | TimedOut>>

// Manual inputs are a Schema struct.
On.manual({ inputs: { reason: Schema.String } }, [qa])
