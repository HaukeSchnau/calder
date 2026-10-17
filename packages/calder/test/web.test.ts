import { describe, expect, it } from "vitest"
import { admit, type Session, sign, verify } from "../src/controller/Web.ts"

const key = Buffer.alloc(32, 7)
const now = 1_800_000_000_000

describe("sessions", () => {
  it("keep their payload until they expire, and only with the key that signed them", () => {
    const value = sign(key, { user: "schnau", expires: now + 1000 })
    expect(verify<Session>(key, value, now)).toEqual({ user: "schnau", expires: now + 1000 })
    expect(verify<Session>(key, value, now + 1000)).toBeUndefined()
    expect(verify<Session>(Buffer.alloc(32, 8), value, now)).toBeUndefined()
  })

  it("refuse a payload someone changed", () => {
    const [, signature] = sign(key, { user: "schnau", expires: now + 1000 }).split(".")
    const forged = `${Buffer.from(JSON.stringify({ user: "mallory", expires: now + 1000 })).toString("base64url")}.${signature}`
    expect(verify<Session>(key, forged, now)).toBeUndefined()
    expect(verify<Session>(key, undefined, now)).toBeUndefined()
    expect(verify<Session>(key, "garbage", now)).toBeUndefined()
  })
})

describe("admit", () => {
  const base = { prefix: "/app", users: ["schnau"] }
  const session = { user: "schnau", expires: now + 1000 }

  it("lets allowed users and sign-in through", () => {
    expect(admit({ ...base, path: "/app/", method: "GET", session })).toBe("pass")
    expect(admit({ ...base, path: "/app/rpc", method: "GET", session })).toBe("pass")
    expect(admit({ ...base, path: "/app/auth/callback", method: "GET", session: undefined })).toBe("pass")
  })

  it("sends pages to sign-in and refuses everything else", () => {
    expect(admit({ ...base, path: "/app/", method: "GET", session: undefined })).toBe("sign-in")
    expect(admit({ ...base, path: "/app/outputs/r/s/o", method: "GET", session: { user: "other", expires: now + 1000 } })).toBe("sign-in")
    expect(admit({ ...base, path: "/app/rpc", method: "GET", session: undefined })).toBe("refuse")
    expect(admit({ ...base, path: "/app/", method: "POST", session: undefined })).toBe("refuse")
  })
})
