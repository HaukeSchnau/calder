import { health } from "./health.ts"
import { test, expect } from "vitest"
test("health", () => expect(health().ok).toBe(true))
