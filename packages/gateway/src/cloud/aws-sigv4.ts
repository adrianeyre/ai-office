import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4 (PRD FR-35): how a request to Claude in Amazon
// Bedrock proves it comes from an IAM identity. The request's method,
// path, query, the headers named as signed and a hash of its body are
// signed with a key derived from the secret access key, the day, the
// region and the service; only the signature leaves AI Office, never the
// secret.

/** An IAM identity's access key: temporary ones carry a session token. */
export interface AwsAccessKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | null | undefined;
}

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding, as AWS wants it: `!'()*` encoded too. */
const escapeUri = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The path as AWS signs it for every service but S3: the path as sent,
 * encoded once more, its slashes kept.
 */
const canonicalPath = (path: string): string =>
  escapeUri(path).replaceAll("%2F", "/");

const canonicalQuery = (search: URLSearchParams): string =>
  [...search]
    .map(([key, value]) => [escapeUri(key), escapeUri(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

/** `20150830T123600Z`: the time a request is signed at. */
export const amzDate = (at: Date): string =>
  at.toISOString().replaceAll(/[-:]|\.\d{3}/g, "");

/** The headers a signed request carries. */
export interface AwsSignature {
  readonly "x-amz-date": string;
  readonly "x-amz-security-token"?: string;
  readonly authorization: string;
}

/**
 * The headers that sign a request with SigV4: `x-amz-date`, the session
 * token (`x-amz-security-token`) when the key is temporary, and
 * `authorization`. Signed are the request's `headers` (their names in any
 * case), its host, those two and its body. The request must be sent with
 * exactly the signed headers' values, to the URL signed.
 */
export function signAwsRequest(
  request: {
    readonly method: string;
    readonly url: string;
    /** Headers to sign besides the host and the date. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array;
  },
  options: {
    readonly key: AwsAccessKey;
    readonly region: string;
    /** The service signed for, such as `bedrock-mantle`. */
    readonly service: string;
    readonly now: Date;
  },
): AwsSignature {
  const url = new URL(request.url);
  const at = amzDate(options.now);
  const day = at.slice(0, 8);
  const { key } = options;
  const added: Omit<AwsSignature, "authorization"> = {
    "x-amz-date": at,
    ...(key.sessionToken != null && key.sessionToken !== ""
      ? { "x-amz-security-token": key.sessionToken }
      : {}),
  };
  const signed = new Map<string, string>();
  for (const [name, value] of Object.entries({
    ...request.headers,
    host: url.host,
    ...added,
  })) {
    signed.set(name.toLowerCase(), value.trim().replaceAll(/\s+/g, " "));
  }
  const names = [...signed.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((name) => `${name}:${signed.get(name) ?? ""}\n`).join(""),
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const scope = `${day}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    at,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${key.secretAccessKey}`, day), options.region),
      options.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
