import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadModels, type LoadedModels } from "./models.ts";

// For tests: the prepared models, read from disk rather than fetched. Vite
// rewrites a model's URL to the path the browser would fetch it from
// (`/src/scene/models/…`), which is a path under the web app's root.

const webRoot = join(import.meta.dirname, "../..");

/** A model file, by the URL the app would fetch. */
export async function readModelFile(url: URL): Promise<ArrayBuffer> {
  const file = await readFile(join(webRoot, decodeURIComponent(url.pathname)));
  // Copied into this realm's ArrayBuffer: under jsdom, Node's is another
  // class, and GLTFLoader tells a GLB from JSON with `instanceof`.
  const data = new ArrayBuffer(file.byteLength);
  new Uint8Array(data).set(file);
  return data;
}

/** Every prepared model, read from disk. */
export const loadModelsFromDisk = (): Promise<LoadedModels> =>
  loadModels(readModelFile);
