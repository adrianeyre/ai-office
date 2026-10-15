// Server-sent events, read chunk by chunk and written one at a time. The
// AI Gateway reads AI Providers' streams with this to translate them, so
// chunks may split an event, a line or a multi-byte character anywhere.

/** One event: its `event:` name (if any) and its `data:` lines joined. */
export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** Reads a stream of server-sent events as its chunks arrive. */
export class SseReader {
  #pending = "";
  readonly #decoder = new TextDecoder();

  /** The events completed by `chunk`. */
  push(chunk: Uint8Array): SseEvent[] {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let end: RegExpExecArray | null;
    while ((end = /\r?\n\r?\n/.exec(this.#pending)) !== null) {
      const event = parseEvent(this.#pending.slice(0, end.index));
      this.#pending = this.#pending.slice(end.index + end[0].length);
      if (event !== undefined) {
        events.push(event);
      }
    }
    return events;
  }

  /** An event left without its closing blank line when the stream ended. */
  end(): SseEvent[] {
    this.#pending += this.#decoder.decode();
    const event = parseEvent(this.#pending);
    this.#pending = "";
    return event === undefined ? [] : [event];
  }
}

function parseEvent(text: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
  }
  return data.length === 0 && event === undefined
    ? undefined
    : { event, data: data.join("\n") };
}

/** An event as `event: …` and `data: …` lines; `data` is JSON-encoded. */
export const sseEvent = (event: string | undefined, data: unknown): string =>
  `${event === undefined ? "" : `event: ${event}\n`}data: ${
    typeof data === "string" ? data : JSON.stringify(data)
  }\n\n`;

/** Every event in a whole stream: for tests and fixtures. */
export function readSse(text: string): SseEvent[] {
  const reader = new SseReader();
  return [...reader.push(new TextEncoder().encode(text)), ...reader.end()];
}
