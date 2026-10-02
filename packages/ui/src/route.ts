import { useSyncExternalStore } from "react"

export type Route =
  | { readonly page: "overview" }
  | { readonly page: "run"; readonly id: string; readonly step: string | null }
  | { readonly page: "rollout"; readonly id: string }
  | { readonly page: "project"; readonly name: string }

export function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?")
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent)
  const [head, a, b] = parts
  if (head === "run" && a) {
    if (b === "rollout") return { page: "rollout", id: a }
    return { page: "run", id: a, step: new URLSearchParams(query).get("step") }
  }
  if (head === "project" && a) return { page: "project", name: a }
  return { page: "overview" }
}

export function href(route: Route): string {
  switch (route.page) {
    case "overview":
      return "#/"
    case "run":
      return `#/run/${encodeURIComponent(route.id)}${route.step ? `?step=${encodeURIComponent(route.step)}` : ""}`
    case "rollout":
      return `#/run/${encodeURIComponent(route.id)}/rollout`
    case "project":
      return `#/project/${encodeURIComponent(route.name)}`
  }
}

/** Selecting a step replaces the history entry; going somewhere else adds one. */
export function go(route: Route, options: { readonly replace?: boolean } = {}) {
  const next = href(route)
  if (location.hash === next) return
  if (options.replace) {
    history.replaceState(null, "", next)
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  } else {
    location.hash = next
  }
}

const subscribe = (f: () => void) => {
  window.addEventListener("hashchange", f)
  return () => window.removeEventListener("hashchange", f)
}

export const useHash = () => useSyncExternalStore(subscribe, () => location.hash)
