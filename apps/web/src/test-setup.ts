// Set up before every web test file (vite.config.ts `test.setupFiles`).
import { configure } from "@testing-library/react";

/**
 * jsdom has no EventSource, and pages open the live event stream. This one
 * connects to nothing and sends nothing; tests of what a stream delivers
 * replace `eventSources.open` (event-stream.ts) instead.
 */
class SilentEventSource {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  close(): void {
    this.readyState = 2;
  }
}

if (!("EventSource" in globalThis)) {
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
}

// jsdom lays nothing out, so it cannot scroll an element into view.
const element: Partial<Element> = Element.prototype;
element.scrollIntoView ??= () => undefined;

// A page's first render in a test file also transforms its modules, which
// under a full parallel run can take longer than Testing Library's default
// one-second wait for `findBy…` and `waitFor`. Waits get five seconds;
// what they wait for is unchanged.
configure({ asyncUtilTimeout: 5000 });
