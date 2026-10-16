import { duration, tally, type Run } from "./model.ts"

/**
 * A run as a row of the wall. `firing` leaves the tiles that ran waiting for the browser to fire
 * them, and the time empty until they settled.
 */
export const runRow = (run: Run, firing = false) => `
<li class="run" data-run="${run.id}">
  <p class="run-label"><span class="run-id">#${run.id}</span> <span class="run-event">${run.event}</span> <span class="run-change">${run.change}</span></p>
  <div class="tiles" aria-hidden="true">${run.tiles
    .map((t) =>
      `<span class="tile" data-state="${t.ran ? (firing ? "waiting" : "ran") : "reused"}" data-key="${t.key}" data-step="${t.step.name}" data-from="${t.from}" style="--g:${t.glaze}"></span>`
    )
    .join("")}</div>
  <p class="run-sum"><span class="run-tally">${tally(run)}</span> <span class="run-time">${firing ? "" : duration(run.seconds)}</span></p>
</li>`
