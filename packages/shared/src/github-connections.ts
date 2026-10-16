import { z } from "zod";

// GitHub connections (ADR 0011): the ways AI Office reaches GitHub, added
// by the Owner in Floor Settings and kept in the database. Each is a
// GitHub App (its ID and PEM private key) or an access token with a
// read-only partner, which is all sandboxes get. The private key and the
// tokens are credentials: sealed at rest and never sent back, only their
// last characters, to tell them apart.

export const githubConnectionKinds = ["app", "access-token"] as const;
export type GitHubConnectionKind = (typeof githubConnectionKinds)[number];

/** The secrets a connection keeps, each sealed for its own column. */
export type GitHubConnectionSecret =
  "private_key" | "token" | "read_only_token";

/**
 * The context a connection's secret is sealed with (`@ai-office/shared/crypto`):
 * it opens nowhere else.
 */
export const githubConnectionSecretContext = (
  id: string,
  secret: GitHubConnectionSecret,
): string => `github_connections.${secret}:${id}`;

/** How many characters of a token or key are shown to tell them apart. */
export const githubConnectionHintLength = 4;

const name = z
  .string({ error: "The name is text." })
  .trim()
  .min(1, { error: "Give the connection a name, or leave it out." })
  .max(100, { error: "Use at most 100 characters for the name." });

/** A GitHub App's numeric ID. */
export const githubAppIdSchema = z
  .string({ error: "Give the GitHub App's ID." })
  .trim()
  .regex(/^\d{1,20}$/, { error: "The App ID is the App's numeric ID." });

/**
 * A GitHub App's PEM private key, as downloaded from the App's settings,
 * or on one line with literal `\n`s.
 */
export const githubPrivateKeySchema = z
  .string({ error: "Give the GitHub App's private key." })
  .transform((value) => value.replaceAll("\\n", "\n").trim())
  .refine(
    (value) =>
      /^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(
        value,
      ),
    { error: "The private key is the App's PEM file, as GitHub gave it." },
  )
  .refine((value) => value.length <= 16_384, {
    error: "The private key is at most 16384 characters.",
  });

/** A fine-grained or classic personal access token, its problems naming the field. */
function accessToken(missing: string, wrong: string) {
  return z
    .string({ error: missing })
    .trim()
    .min(1, { error: missing, abort: true })
    .regex(/^[\w-]{20,255}$/, { error: wrong });
}

/** A fine-grained or classic personal access token. */
export const githubAccessTokenSchema = accessToken(
  "Give the access token.",
  "That is not a GitHub access token.",
);

/** The read-only partner of an access token: what sandboxes get. */
const githubReadOnlyAccessTokenSchema = accessToken(
  "Give a read-only access token too: sandboxes get it, never the access token.",
  "The read-only access token is not a GitHub access token.",
);

/** The body of `POST /api/github/connections/apps`. */
export const githubAppConnectionCreateSchema = z.strictObject({
  /** `GitHub App <appId>` when left out. */
  name: name.optional(),
  appId: githubAppIdSchema,
  privateKey: githubPrivateKeySchema,
});
export type GitHubAppConnectionCreate = z.infer<
  typeof githubAppConnectionCreateSchema
>;

/** The body of `POST /api/github/connections/access-tokens`. */
export const githubAccessTokenConnectionCreateSchema = z
  .strictObject({
    name: name.optional(),
    token: githubAccessTokenSchema,
    /** What sandboxes get: a token that can read the repositories and change nothing. */
    readOnlyToken: githubReadOnlyAccessTokenSchema,
  })
  .refine(({ token, readOnlyToken }) => token !== readOnlyToken, {
    error:
      "The read-only token must be another token, one that can only read: sandboxes get it.",
    path: ["readOnlyToken"],
  });
export type GitHubAccessTokenConnectionCreate = z.infer<
  typeof githubAccessTokenConnectionCreateSchema
>;

/** The body of `PATCH /api/github/connections/:id`: its name, and whether it is used. */
export const githubConnectionUpdateSchema = z
  .strictObject({ name, enabled: z.boolean() })
  .partial()
  .refine((update) => Object.keys(update).length > 0, {
    error: "Say what to change: the name, or whether it is used.",
  });
export type GitHubConnectionUpdate = z.infer<
  typeof githubConnectionUpdateSchema
>;

/** A GitHub connection, as the API sends it: never its key or tokens. */
export const githubConnectionSchema = z.object({
  id: z.string(),
  kind: z.enum(githubConnectionKinds),
  name: z.string(),
  /** The App's ID; null for an access token. */
  appId: z.string().nullable(),
  /** The private key's or the token's last characters, to tell it apart. */
  hint: z.string(),
  /** False while disabled: not used, but kept to enable again. */
  enabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type GitHubConnection = z.infer<typeof githubConnectionSchema>;

/** The body of `GET /api/github/connections`: in the order they are tried. */
export const githubConnectionListSchema = z.object({
  connections: z.array(githubConnectionSchema),
});
export type GitHubConnectionList = z.infer<typeof githubConnectionListSchema>;

/** Each kind, for people. */
export const githubConnectionKindNames: Record<GitHubConnectionKind, string> = {
  app: "GitHub App",
  "access-token": "Access token",
};
