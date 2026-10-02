import { useEffect, useRef, useSyncExternalStore } from "react"

/**
 * Single-key shortcuts for the page, skipped while typing in a field or while a dialog is open.
 * Modifier chords reach the handler only with `withModifiers`.
 */
export function useKeys(handler: (e: KeyboardEvent) => void, options: { readonly withModifiers?: boolean } = {}) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("[data-modal]")) return
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return
      if ((e.metaKey || e.ctrlKey || e.altKey) && !options.withModifiers) return
      ref.current(e)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [options.withModifiers])
}

const phoneQuery = window.matchMedia("(max-width: 760px)")
const subscribePhone = (f: () => void) => {
  phoneQuery.addEventListener("change", f)
  return () => phoneQuery.removeEventListener("change", f)
}

export const usePhone = () => useSyncExternalStore(subscribePhone, () => phoneQuery.matches)
