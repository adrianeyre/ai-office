import { create } from "zustand";

import { destination } from "./camera-rig.ts";
import { defaultView, useCameraStore } from "./camera-store.ts";
import {
  inspectableViewName,
  isInspectable,
  type Inspectable,
  type InspectableObject,
} from "./inspectable.ts";
import { useSelectionStore } from "./selection-store.ts";

// Opening an inspectable object (PRD FR-58) selects it, which opens its
// HTML panel, and flies the camera in to it; closing it flies back to
// where the camera was. Clicking it in the scene, picking it in the
// keyboard list and the Office's address all come here.

/** The inspectable object whose panel is open, if any. */
export const inspected = (): Inspectable | undefined => {
  const { selected } = useSelectionStore.getState();
  return isInspectable(selected) ? selected : undefined;
};

/**
 * Open an object's panel and fly in to it. Opened from another object's
 * panel, the camera still goes back to where it was before the first.
 */
export function openInspectable(object: InspectableObject): void {
  const camera = useCameraStore.getState();
  const selection = useSelectionStore.getState();
  const returnView =
    inspected() === undefined
      ? (destination(camera.rig) ?? defaultView)
      : (selection.returnView ?? defaultView);
  const view = inspectableViewName(object);
  camera.registerView(view, object.view);
  camera.flyTo(view);
  selection.select({ kind: object.kind, id: object.id }, returnView);
}

/**
 * Close the open panel and fly back to where the camera was, unless
 * `flyBack` is false (the lift is taking the camera elsewhere).
 */
export function closeInspectable({
  flyBack = true,
}: { flyBack?: boolean } = {}): void {
  if (inspected() === undefined) {
    return;
  }
  const selection = useSelectionStore.getState();
  const returnView = selection.returnView ?? defaultView;
  selection.clearSelection();
  if (flyBack) {
    useCameraStore.getState().flyTo(returnView);
  }
}

/**
 * The Agent whose panel is to open on its chat rather than its card: asked
 * by the Office's "Chat with the Manager" button, taken by the panel.
 */
export const useChatRequest = create<{
  readonly agentId: string | undefined;
}>()(() => ({ agentId: undefined }));

/** Open an Agent's panel, and its chat in it, flying in to the Agent. */
export function openAgentChat(object: InspectableObject): void {
  useChatRequest.setState({ agentId: object.id });
  openInspectable(object);
}

/** Take the chat asked for an Agent, if one was: it is asked once. */
export function takeChatRequest(agentId: string): boolean {
  if (useChatRequest.getState().agentId !== agentId) {
    return false;
  }
  useChatRequest.setState({ agentId: undefined });
  return true;
}
