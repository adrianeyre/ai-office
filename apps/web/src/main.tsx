// The interface's typefaces, served from AI Office itself (styles.css).
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";

import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element.");
}

createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} queryClient={new QueryClient()} />
  </StrictMode>,
);
