import "@fontsource-variable/instrument-sans/wght.css"
import "@fontsource-variable/jetbrains-mono/wght.css"
import "./app.css"
import { RegistryProvider } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider defaultIdleTTL={2000}>
        <App />
      </RegistryProvider>
    </StrictMode>,
  )
}
