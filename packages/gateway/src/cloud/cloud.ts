import {
  awsCredentialsSchema,
  serviceAccountKeySchema,
  type AwsCredentials,
  type CloudPlatform,
  type ServiceAccountKey,
} from "@ai-office/shared";

import {
  AwsProfileError,
  readAwsProfile,
  type AwsConfigFiles,
} from "./aws-profile.ts";
import { signAwsRequest, type AwsAccessKey } from "./aws-sigv4.ts";
import { GoogleAuthError, type GoogleTokenCache } from "./google-auth.ts";

// Claude through a cloud platform (PRD FR-35): an AWS Bedrock or Google
// Vertex AI AI Account. Each request the Gateway would send to Anthropic's
// Messages API is reshaped for the platform and signed with the platform's
// own credentials, never an API key:
// - AWS Bedrock (Claude in Amazon Bedrock) serves the Messages API itself
//   at `/anthropic/v1/messages`, streaming as Anthropic does. The body goes
//   unchanged; the request is signed with SigV4 for `bedrock-mantle` in
//   the account's region, with its IAM access key or its profile's.
// - Google Vertex AI names the Model in the path and wants
//   `anthropic_version` in the body: `…/publishers/anthropic/models/
//   {model}:rawPredict`, or `:streamRawPredict` for a stream, and
//   `count-tokens:rawPredict` to count tokens. Its answers are Anthropic's.
//   Each request carries the service account's access token.
// A credential is stored as JSON: the access key or profile, or the
// service account's key.

/** Vertex AI's version of the Messages API. */
export const vertexAnthropicVersion = "vertex-2023-10-16";

/** The service Claude in Amazon Bedrock is signed for. */
export const bedrockSigningService = "bedrock-mantle";

/** A cloud platform account's credential, opened. */
export type CloudCredential =
  | { readonly platform: "bedrock"; readonly aws: AwsCredentials }
  | { readonly platform: "vertex"; readonly serviceAccount: ServiceAccountKey };

/** The credential an account of `platform` stores, as text to seal. */
export const cloudCredentialText = (credential: CloudCredential): string =>
  JSON.stringify(
    credential.platform === "bedrock"
      ? credential.aws
      : credential.serviceAccount,
  );

/** A stored credential, opened, read for `platform`. */
export function parseCloudCredential(
  platform: CloudPlatform,
  text: string,
): CloudCredential {
  const json: unknown = JSON.parse(text);
  return platform === "bedrock"
    ? { platform, aws: awsCredentialsSchema.parse(json) }
    : { platform, serviceAccount: serviceAccountKeySchema.parse(json) };
}

/**
 * What in a cloud credential is secret, to redact everywhere and to keep
 * out of sandboxes: the access key (its ID too) or the service account's
 * private key. A profile's name is not; its keys are told when read.
 */
export const cloudSecrets = (credential: CloudCredential): string[] =>
  credential.platform === "bedrock"
    ? "profile" in credential.aws
      ? []
      : [
          credential.aws.accessKeyId,
          credential.aws.secretAccessKey,
          ...(credential.aws.sessionToken == null
            ? []
            : [credential.aws.sessionToken]),
        ]
    : [
        credential.serviceAccount.private_key,
        ...(credential.serviceAccount.private_key_id === undefined
          ? []
          : [credential.serviceAccount.private_key_id]),
      ];

/** A request the platform cannot take; the caller's fault (400). */
export class CloudRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudRequestError";
  }
}

/** The platform's credentials could not be used to sign a request. */
export class CloudCredentialsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudCredentialsError";
  }
}

/** A Messages API request, as it goes to a cloud platform. */
export interface CloudRequest {
  /** Its URL. */
  readonly url: string;
  /** Its path (and query) on the platform, as recorded. */
  readonly path: string;
  readonly body: Buffer;
  /** The headers that sign it: sent, never recorded. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * How a cloud platform's account sends a request (FR-35), in place of an
 * API key: `prepare` reshapes a request for Anthropic's `/v1/messages` or
 * `/v1/messages/count_tokens` (and its body) for the platform, and signs
 * it. A `CloudRequestError` for a request the platform cannot take, and a
 * `CloudCredentialsError` when its credentials cannot sign.
 */
export interface CloudSigner {
  readonly platform: CloudPlatform;
  prepare(path: string, body: Buffer): Promise<CloudRequest>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A Model's name in a Vertex AI path: `@` and `.` stay as they are. */
const pathModel = (model: string): string =>
  encodeURIComponent(model).replaceAll("%40", "@");

export interface CloudSignerOptions {
  readonly credential: CloudCredential;
  /** The account's id, which its access tokens are kept by. */
  readonly accountId: string;
  /** Its platform's API (or the Owner's endpoint), without a path. */
  readonly baseUrl: string;
  readonly region: string;
  /** A Vertex AI account's Google Cloud project. */
  readonly projectId: string | null;
  readonly awsConfigFiles: AwsConfigFiles;
  readonly googleTokens: GoogleTokenCache;
  /** Told each secret read from a profile, so it can be redacted. */
  readonly onSecret: (secret: string) => void;
  readonly now: () => Date;
}

/** How an account of a cloud platform sends its requests. */
export function cloudSigner(options: CloudSignerOptions): CloudSigner {
  const { credential, region } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  const endpoint = (path: string) => path.replace(/^\/v1(?=\/|$)/, "");

  if (credential.platform === "bedrock") {
    const accessKey = async (): Promise<AwsAccessKey> => {
      const { aws } = credential;
      if (!("profile" in aws)) {
        return aws;
      }
      try {
        const key = await readAwsProfile(aws.profile, options.awsConfigFiles);
        options.onSecret(key.accessKeyId);
        options.onSecret(key.secretAccessKey);
        if (key.sessionToken != null) {
          options.onSecret(key.sessionToken);
        }
        return key;
      } catch (error) {
        throw new CloudCredentialsError(
          error instanceof AwsProfileError
            ? error.message
            : "The AWS profile could not be read.",
          { cause: error },
        );
      }
    };
    return {
      platform: "bedrock",
      async prepare(path, body) {
        const sentPath = `/anthropic/v1${endpoint(path)}`;
        const url = `${base}${sentPath}`;
        return {
          url,
          path: sentPath,
          body,
          headers: {
            ...signAwsRequest(
              { method: "POST", url, body },
              {
                key: await accessKey(),
                region,
                service: bedrockSigningService,
                now: options.now(),
              },
            ),
          },
        };
      },
    };
  }

  const { serviceAccount } = credential;
  const project = options.projectId ?? serviceAccount.project_id ?? "";
  const models = `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/anthropic/models`;
  return {
    platform: "vertex",
    async prepare(path, body) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      if (!isObject(parsed)) {
        throw new CloudRequestError("The request body is not a JSON object.");
      }
      const version =
        typeof parsed["anthropic_version"] === "string"
          ? parsed["anthropic_version"]
          : vertexAnthropicVersion;
      let sentPath: string;
      let sent: Record<string, unknown>;
      if (endpoint(path) === "/messages/count_tokens") {
        // Counting names the Model in the body, as Anthropic's does.
        sentPath = `${models}/count-tokens:rawPredict`;
        sent = { ...parsed, anthropic_version: version };
      } else {
        const { model, ...rest } = parsed;
        if (typeof model !== "string" || model.trim() === "") {
          throw new CloudRequestError(
            "The request names no Model, which Vertex AI needs.",
          );
        }
        sentPath = `${models}/${pathModel(model)}:${
          rest["stream"] === true ? "streamRawPredict" : "rawPredict"
        }`;
        sent = { ...rest, anthropic_version: version };
      }
      let token: string;
      try {
        token = await options.googleTokens.token(
          options.accountId,
          serviceAccount,
        );
      } catch (error) {
        throw new CloudCredentialsError(
          error instanceof GoogleAuthError
            ? error.message
            : "The service account could not sign in.",
          { cause: error },
        );
      }
      return {
        url: `${base}${sentPath}`,
        path: sentPath,
        body: Buffer.from(JSON.stringify(sent), "utf8"),
        headers: { authorization: `Bearer ${token}` },
      };
    },
  };
}
