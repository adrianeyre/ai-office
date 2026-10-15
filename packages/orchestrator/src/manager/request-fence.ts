import type { ChatRequest } from "@ai-office/shared";

import { readByAgents, runByCi } from "../merge/owner-only.ts";

// A deterministic fence on what a chat request's Batch may touch (P2-3,
// the Owner's decision in #199, option 4). A chat request is filed and
// started at once (ADR 0004), on a Plan the Manager's session wrote after
// reading the repository, the web and attachments, and the binding check
// (`request-binding.ts`) that ties it to the Owner's words is a model's
// judgement. This is not: a Plan whose issues name a file that holds
// secrets, says what CI runs or installs (dependencies among them), or is
// read by later Agents as memory, Skills or instructions, is filed only
// when the Owner's own words name that file too. Otherwise nothing is
// filed, before the binding check is even asked.
//
// The rules on CI and on what Agents read are the Merge Policy's own
// (`owner-only.ts`, P1-2 and P1-3), so the fence and the merge agree on
// what is the Owner's alone. What an Agent changes beyond its issue is the
// Merge Policy's to catch: every chat request's pull request goes to the
// Owner too (`merge.ts`).

/** Folders whose files hold secrets or credentials, wherever they are. */
const secretFolders = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  "secrets",
  ".secrets",
]);

/** Names of files that hold secrets or credentials. */
const secretNames: readonly RegExp[] = [
  /^\.env(\..+)?$/,
  /\.(pem|key|crt|p12|pfx|jks|keystore|kdbx|gpg|asc|tfvars)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^\.netrc$/,
  /^\.?htpasswd$/,
  /^\.git-credentials$/,
  /^credentials?(\.\w+)?$/,
  /^secrets?(\.\w+)?$/,
  /^service[-_]?account.*\.json$/,
];

/** Whether `path` holds secrets or credentials. */
export function holdsSecrets(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.some((part) => secretFolders.has(part)) ||
    secretNames.some((pattern) => pattern.test(name))
  );
}

/**
 * Why a chat request may touch `path` only when the Owner names it, as a
 * phrase for the chat; undefined when it may touch it anyway.
 */
export function fencedBecause(path: string): string | undefined {
  if (holdsSecrets(path)) {
    return "holds secrets or credentials";
  }
  if (runByCi(path)) {
    return "changes what CI runs or installs";
  }
  if (readByAgents(path)) {
    return "changes what Agents read as memory, Skills or instructions";
  }
  return undefined;
}

/** File names that are paths though they have neither a dot nor a slash. */
const bareFileNames =
  /^(dockerfile|containerfile|makefile|gnumakefile|justfile|jenkinsfile|rakefile|gemfile|pipfile|procfile|gradlew|mvnw)$/i;

/** What a path is compared as: lower case, without `./` or a closing `/`. */
const normal = (path: string): string =>
  path
    .toLowerCase()
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

/** The words of `text`, each stripped of the punctuation that closes a sentence. */
const wordsOf = (text: string): string[] =>
  text
    .split(/[\s`'"()<>[\]{},;|*]+/)
    .map((word) => word.replace(/[.:!?]+$/, ""))
    .filter((word) => word !== "");

/**
 * The paths `text` names: each word made only of a path's characters that
 * has a slash or a dot in it, or is a file name such as `Dockerfile`. An
 * address (`https://…`) is not one.
 */
export function pathsIn(text: string): string[] {
  return wordsOf(text).filter(
    (word) =>
      /^[\w@.~+-]+(\/[\w@.~+-]*)*$/.test(word) &&
      (/[./]/.test(word) || bareFileNames.test(word)),
  );
}

/** Whether the Owner's words name `path`: the path, its tail, or a folder it is in. */
const named = (path: string, ownerWords: readonly string[]): boolean => {
  const wanted = normal(path);
  return ownerWords.some((word) => {
    const said = normal(word);
    return (
      said !== "" &&
      (wanted === said ||
        wanted.endsWith(`/${said}`) ||
        wanted.startsWith(`${said}/`))
    );
  });
};

/** A path the Plan names that the Owner's words do not, and why it matters. */
export interface FencedPath {
  readonly path: string;
  readonly because: string;
}

/**
 * The paths a Batch decision names that only the Owner may ask for, and
 * that the Owner's own words do not name: every issue's files, and every
 * path in its title, body, acceptance criteria and its one-off Roles'
 * descriptions and instructions. Empty when the Plan may be filed.
 */
export function fencedPaths(
  decision: Extract<ChatRequest, { readonly decision: "batch" }>,
  ownerWords: readonly string[],
): FencedPath[] {
  const owner = ownerWords.flatMap(wordsOf);
  const candidates = [
    ...decision.issues.flatMap((issue) => [
      ...issue.files,
      ...pathsIn(
        [issue.title, issue.body, ...issue.acceptanceCriteria].join("\n"),
      ),
    ]),
    ...decision.roles.flatMap((role) =>
      pathsIn([role.description, role.instructions].join("\n")),
    ),
  ];
  const fenced = new Map<string, FencedPath>();
  for (const path of candidates) {
    const key = normal(path);
    const because = fencedBecause(key);
    if (
      key !== "" &&
      because !== undefined &&
      !fenced.has(key) &&
      !named(key, owner)
    ) {
      fenced.set(key, { path: path.replace(/^(\.\/)+/, ""), because });
    }
  }
  return [...fenced.values()];
}
