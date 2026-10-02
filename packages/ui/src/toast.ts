import { useSyncExternalStore } from "react"

export interface Toast {
  readonly text: string
  readonly kind: "info" | "bad"
  readonly at: number
}

let current: Toast | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

/** A short message in the status bar, gone after a few seconds. */
export function toast(text: string, kind: Toast["kind"] = "info") {
  current = { text, kind, at: Date.now() }
  listeners.forEach((f) => f())
  clearTimeout(timer)
  timer = setTimeout(() => {
    current = null
    listeners.forEach((f) => f())
  }, 6000)
}

const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => listeners.delete(f)
}

export const useToast = () => useSyncExternalStore(subscribe, () => current)
