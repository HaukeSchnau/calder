/**
 * The attribute paths of Calder's evaluator expression (Resolve.ts `evaluator`), which it hands Nix as a
 * JSON string of their components, joined back with dots.
 */
export const askedAttrs = (expr: string): Array<string> => {
  const literal = /paths = builtins\.fromJSON ("(?:[^"\\]|\\.)*");/.exec(expr)?.[1]
  if (literal === undefined) return []
  const json = literal.slice(1, -1).replace(/\\(.)/g, "$1")
  return (JSON.parse(json) as Array<Array<string>>).map((parts) => parts.join("."))
}

/** The tag Calder's evaluator expression reports under (Resolve.ts `evaluator`): `trace: calder-derivation-<tag> ...`. */
export const reportTag = (expr: string): string => /calder-flake-([0-9a-f]+)/.exec(expr)?.[1] ?? ""
