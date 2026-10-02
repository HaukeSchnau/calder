# @kiln/ui notes

## Running it

- `pnpm --filter @kiln/ui mock` starts the stand-in controller on 127.0.0.1:8791 (`KILN_MOCK_PORT`), with `UiRpcs` over a WebSocket at `/rpc` and JSON serialization, like the controller.
- `pnpm --filter @kiln/ui dev` serves the UI on 127.0.0.1:8790 and proxies `/rpc` to the mock.
- `pnpm --filter @kiln/ui build` writes `dist/` with relative asset paths. `vite preview` (port 8792) serves it with the same proxy.

The mock's scenario is planned once at start and is a pure function of the clock afterwards: two running runs with live logs, a deploy of t3code to srv-2 and then srv-1 that takes about 18 minutes, a failed pull request run with failing and flaky tests, a red main on hopwatch, and a plan error on igs. Restart the mock to see the deploy again.

## What the UI needed from the API

The UI works around each of these today. None blocks v0.

1. **Which step deploys.** Nothing marks a step as the deploy, and a `Deployment` names its run but not the step. The UI treats an action as the deploy when its value type starts with `@kiln/std/Release/` or its detail mentions `Release.promote` (`isDeployStep` in `src/run.tsx`). A `deploys: boolean` on `StepRun`, or `step` next to `Deployment.deployingRun`, would replace the guess.
2. **Labels for `reusedFrom`.** It is a bare run id. To write "reused from #611" the UI looks the id up among the siblings and the overview's runs, and falls back to "reused". Carrying `{ id, project, number }` would make it exact.
3. **Gaps in `changes`.** Changes have no sequence number, so a client can't tell whether it missed one between loading a snapshot and the stream starting, or across a reconnect. The UI subscribes before it loads, reloads after reconnecting, and refetches the overview every 15 seconds. A `seq` on each change and on snapshots would let it resume exactly.
4. **Failing tests after a failure.** `failingTests` only come with `run`, so the UI refetches the whole run when a step turns failed.
5. **Rollout history.** There is no list of past deploys per project or host, so the rollout page shows what `Deployment` holds (previous, live, pending) and leaves out B's deploy history table. The overview can only link a live revision to its rollout when it is the latest main run's.
6. **Expected durations.** Running steps have no expected duration, so nodes show elapsed time without progress. `stepStats` could supply a median at the cost of one query per running step.
7. **Paging logs.** `logs` has no limit or cursor, so a long log arrives whole; the UI renders the last 3000 matching lines.
8. **Span attributes.** The trace tab maps spans to steps through `StepRun.spanId` and the `kiln.step` attribute, and colours them by `kiln.kind`, `kiln.status` and `http.status`. These names are part of the contract in practice and could be documented in `Domain.Span`.
9. **Slots per host.** `Overview.slots` is fleet-wide, so the overview shows it once rather than per host.
