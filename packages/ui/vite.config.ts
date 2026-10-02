import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The controller serves dist/ and the RPC socket on one origin; in development the mock server
// stands in for it behind the same path.
const rpc = { "/rpc": { target: `ws://127.0.0.1:${process.env["KILN_MOCK_PORT"] ?? 8791}`, ws: true } }

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 8790, strictPort: true, proxy: rpc },
  preview: { host: "127.0.0.1", port: 8792, strictPort: true, proxy: rpc },
})
