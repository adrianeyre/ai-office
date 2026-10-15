import { Transform } from "node:stream";

import { minimumSecretLength, redactedText } from "@ai-office/shared";

// No answer the AI Gateway sends a caller carries the credential of the AI
// Account that served it (ADR 0001: a sandbox never holds one; pen-testing
// G1-6). An AI Provider, a compatible endpoint or a proxy in front of one
// may name the credential it was given, in an error or anywhere else, so
// whatever comes back from it (its headers, a whole body, a stream, passed
// through or translated) has that credential replaced with `redactedText`
// on its way to the caller.

/**
 * The credential a request was sent with, in each form it took: the
 * account's key or token, and each header that presented it (a bearer
 * token alone too). Values shorter than the redactor's minimum are left
 * out, as it leaves them out: they would match noise.
 */
export function credentialsSent(
  apiKey: string,
  auth: Readonly<Record<string, string>>,
): readonly string[] {
  const forms = [apiKey];
  for (const value of Object.values(auth)) {
    forms.push(value, value.replace(/^Bearer\s+/i, ""));
  }
  return [...new Set(forms)]
    .filter((form) => form.length >= minimumSecretLength)
    .sort((a, b) => b.length - a.length);
}

/** `text` with every one of `credentials` replaced. */
export function scrubbed(text: string, credentials: readonly string[]): string {
  let result = text;
  for (const credential of credentials) {
    result = result.replaceAll(credential, redactedText);
  }
  return result;
}

/** `headers` with every one of `credentials` replaced in their values. */
export function scrubbedHeaders(
  headers: Readonly<Record<string, string>>,
  credentials: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = scrubbed(value, credentials);
  }
  return result;
}

const redactedBytes = Buffer.from(redactedText, "utf8");

/** `data` with every `credential` in it replaced. */
function replacedIn(data: Buffer, credential: Buffer): Buffer {
  let at = data.indexOf(credential);
  if (at === -1) {
    return data;
  }
  const parts: Buffer[] = [];
  let from = 0;
  while (at !== -1) {
    parts.push(data.subarray(from, at), redactedBytes);
    from = at + credential.length;
    at = data.indexOf(credential, from);
  }
  parts.push(data.subarray(from));
  return Buffer.concat(parts);
}

/**
 * How many bytes at the end of `data` could be the start of a credential
 * the next chunk finishes: held back until it comes.
 */
function partialAtEnd(data: Buffer, credentials: readonly Buffer[]): number {
  let longest = 0;
  for (const credential of credentials) {
    for (
      let length = Math.min(credential.length - 1, data.length);
      length > longest;
      length -= 1
    ) {
      if (
        data[data.length - length] === credential[0] &&
        data
          .subarray(data.length - length)
          .equals(credential.subarray(0, length))
      ) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/**
 * A stream that passes bytes through with every one of `credentials`
 * replaced, even one split across chunks. Only bytes that could be the
 * start of one are held back, so a stream's events are not delayed.
 */
export function scrubbing(credentials: readonly string[]): Transform {
  const forms = credentials.map((credential) =>
    Buffer.from(credential, "utf8"),
  );
  let held: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (forms.length === 0) {
        callback(null, chunk);
        return;
      }
      let data = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
      for (const form of forms) {
        data = replacedIn(data, form);
      }
      const keep = partialAtEnd(data, forms);
      held = data.subarray(data.length - keep);
      callback(null, data.subarray(0, data.length - keep));
    },
    flush(callback) {
      callback(null, held);
    },
  });
}
