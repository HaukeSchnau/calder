import type { Domain } from "@calder-ci/api"
import { useAtomValue } from "@effect/atom-react"
import { agentWaitsAtom } from "./data.ts"
import { article } from "./format.ts"

const Meter = ({ used, max }: { readonly used: number; readonly max: number }) => (
  <span className="slots" aria-hidden="true">{Array.from({ length: max }, (_, i) => <i key={i} className={i < used ? "on" : ""} />)}</span>
)

/**
 * Slot use per host: the controller's host with tasks and builds, then each agent. A gone agent shows
 * as offline, in red while a step waits for it, and an agent of another compatibility version in red;
 * a platform no agent ever served shows when awaited.
 */
export function HostSlots({ ov, compact = false }: { readonly ov: Domain.Overview; readonly compact?: boolean }) {
  const waits = useAtomValue(agentWaitsAtom)
  const unknown = [...new Set(waits.filter((w) => w.agent === null).map((w) => w.platform))]
  const { slots } = ov
  return (
    <span className={compact ? "hslots compact" : "hslots"}>
      <span className="hsl">
        <b>srv-2</b>
        <span>tasks</span>{compact ? null : <Meter used={slots.tasks} max={slots.tasksMax} />}<span className="n">{slots.tasks}/{slots.tasksMax}</span>
        <span>builds</span>{compact ? null : <Meter used={slots.builds} max={slots.buildsMax} />}<span className="n">{slots.builds}/{slots.buildsMax}</span>
      </span>
      {ov.agents.map((a) => {
        const awaited = waits.filter((w) => w.agent === a.name)
        if (a.connected && !a.current) {
          return (
            <span key={a.name} className="hsl gone" data-tip={`${a.name} has compatibility version ${a.compatibility} (Calder build ${a.build}), not the controller's, and gets no jobs`}>
              <b>{a.name}</b><span className="bad">incompatible</span>
            </span>
          )
        }
        return a.connected ? (
          <span key={a.name} className="hsl" data-tip={`${a.name}, ${a.platform} agent, compatibility version ${a.compatibility} (Calder build ${a.build})`}>
            <b>{a.name}</b>
            {compact ? null : <Meter used={a.running} max={a.slots} />}<span className="n">{a.running}/{a.slots}</span>
          </span>
        ) : (
          <span key={a.name} className="hsl gone" data-tip={awaited.length ? `${awaited.map((w) => w.step.name).join(", ")} waits for ${a.name}` : `${a.name}, ${a.platform} agent, disconnected`}>
            <b>{a.name}</b><span className={awaited.length ? "bad" : "dim"}>offline</span>
          </span>
        )
      })}
      {unknown.map((platform) => (
        <span key={platform} className="hsl gone" data-tip={`waits for ${article(platform)} ${platform} agent`}>
          <b>{platform}</b><span className="bad">no agent</span>
        </span>
      ))}
    </span>
  )
}
