# @calder-ci/ui notes

## Running it

- `pnpm --filter @calder-ci/ui mock` starts the stand-in controller on 127.0.0.1:8791 (`CALDER_MOCK_PORT`), with `UiRpcs` over a WebSocket at `/rpc` and JSON serialization, like the controller.
- `pnpm --filter @calder-ci/ui dev` serves the UI on 127.0.0.1:8790 and proxies `/rpc` to the mock.
- `pnpm --filter @calder-ci/ui build` writes `dist/` with relative asset paths. `vite preview` (port 8792) serves it with the same proxy.

The mock's scenario is planned once at start and is a pure function of the clock afterwards: two running runs with live logs, a deploy of t3code to srv-2 and then srv-1 that takes about 18 minutes, a failed pull request run with failing and flaky tests, a red main on hopwatch, and a plan error on igs. t3code's `projectRelease` logs 3000 lines, so its log pages back. The deploying t3code main run packages the desktop app on the m1 agent. `CALDER_MOCK_M1=offline pnpm --filter @calder-ci/ui mock` starts it with m1 gone, so that run's testflight waits for an aarch64-darwin agent. Restart the mock to see the deploy again.
