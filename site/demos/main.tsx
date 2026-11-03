// The page's one script, which Vite bundles into dist/assets/. It runs the
// page's enhancements (script.mts) and mounts each product demo into its
// `data-demo` slot in index.html. The demos are pictures: each slot is
// aria-hidden, with its text equivalent beside it in the page, and without
// JavaScript the slot stays empty and the page still reads in full.
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "../script.mts";
import "./look.css";
import HeroDemo from "./hero";
import GatewayDemo from "./gateway";
import ChatDemo from "./chat";
import TemplatesDemo from "./templates";
import {
  ConnectionsTile,
  MergePolicyTile,
  NoticesTile,
  TokenCapTile,
} from "./bento";

/** Each `data-demo` name in index.html, and what it mounts. */
const demos: Record<string, ComponentType> = {
  hero: HeroDemo,
  gateway: GatewayDemo,
  chat: ChatDemo,
  templates: TemplatesDemo,
  notices: NoticesTile,
  "token-cap": TokenCapTile,
  "merge-policy": MergePolicyTile,
  connections: ConnectionsTile,
};

for (const slot of document.querySelectorAll<HTMLElement>("[data-demo]")) {
  const name = slot.dataset.demo ?? "";
  if (!Object.hasOwn(demos, name)) {
    throw new Error(`index.html names an unknown demo "${name}"`);
  }
  const Demo = demos[name];
  createRoot(slot).render(
    <StrictMode>
      <Demo />
    </StrictMode>,
  );
}
