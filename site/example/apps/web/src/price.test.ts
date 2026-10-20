import { price } from "./price.ts"
import { test, expect } from "vitest"
test("price", () => expect(price(250)).toBe("€2.50"))
