// Central redaction (PRD FR-5, §7 Security): whatever is about to be logged
// or emitted passes through a Redactor, which removes the secret values
// registered with it and anything shaped like a credential. It runs in the
// browser too, so it uses no Node APIs.

export const redactedText = "[REDACTED]";

export interface CredentialPattern {
  readonly name: string;
  /** Must be global (`g`). */
  readonly pattern: RegExp;
  /** Defaults to replacing the whole match. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

const keepPrefix = (_match: string, prefix: string): string =>
  `${prefix}${redactedText}`;

/** Credential shapes removed from every string, wherever they appear. */
export const credentialPatterns: readonly CredentialPattern[] = [
  {
    // PEM private keys (the GitHub App key, SSH keys). An unterminated one,
    // say from a truncated line, is removed up to the next quote or the end.
    // A PEM body never holds a quote, so a JSON log line stays valid.
    name: "private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[^"]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[^"]*)/g,
  },
  {
    // Anthropic API keys (sk-ant-api03-…) and OAuth tokens (sk-ant-oat01-…).
    name: "Anthropic key or token",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  },
  {
    // OpenAI API keys: sk-…, sk-proj-…, sk-svcacct-…, sk-admin-….
    name: "OpenAI key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
  },
  { name: "xAI key", pattern: /\bxai-[A-Za-z0-9_-]{20,}/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    name: "Google OAuth token",
    pattern: /\b(?:ya29\.[0-9A-Za-z._-]{20,}|1\/\/0[0-9A-Za-z_-]{20,})/g,
  },
  {
    // The secret of an OAuth client the Owner registers in Google Cloud
    // (Google sign-in for the Google Connections).
    name: "Google OAuth client secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // Personal, OAuth, user-to-server, server-to-server (App installation)
    // and refresh tokens, and fine-grained personal access tokens.
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  {
    // AI Office's own Gateway Keys (`gatewayKeyPrefix`).
    name: "Gateway Key",
    pattern: /\baio_gk_[A-Za-z0-9_-]{16,}/g,
  },
  {
    // `btr-` load-balancer keys, the shape Gateway Keys are compared to.
    name: "btr- key",
    pattern: /\bbtr-[A-Za-z0-9_-]{16,}/g,
  },
  { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    // Slack's bot, user, app and refresh tokens (a Slack Connection's).
    name: "Slack token",
    pattern: /\bxox[abeposr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    // A Slack incoming webhook's address is its credential.
    name: "Slack webhook address",
    pattern:
      /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  },
  {
    // ntfy's access tokens (an ntfy Connection's).
    name: "ntfy access token",
    pattern: /\btk_[A-Za-z0-9]{29}\b/g,
  },
  {
    // JWTs, the shape of most OAuth access and ID tokens.
    name: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "Authorization header value",
    pattern: /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: keepPrefix,
  },
  {
    // The password in scheme://user:password@host (DATABASE_URL, proxies).
    name: "URL password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"']+:)[^\s@/?#"']+(?=@)/gi,
    replace: keepPrefix,
  },
  {
    // Includes `secret=`, which carries the TOTP secret in otpauth:// URIs.
    name: "credential in a query string",
    pattern:
      /([?&](?:access_token|refresh_token|id_token|client_secret|secret|api_key|apikey|token)=)[^&\s#"']+/gi,
    replace: keepPrefix,
  },
  {
    // `"password":"x"`, `"apiKey":"x"` in JSON (the value stays a string).
    name: "credential in JSON",
    pattern:
      /("[A-Za-z0-9_-]*(?:password|passwd|secret|api_?key|access_?token|refresh_?token|id_?token|private_?key|encryption_?key|gateway_?key|authorization|cookie)"\s*:\s*")(?:[^"\\]|\\.)*(?=")/gi,
    replace: keepPrefix,
  },
  {
    // `password: x`, `DB_PASSWORD=x`, `client_secret=x` and the like in text.
    name: "credential assignment",
    pattern:
      /\b([A-Za-z0-9_]*(?:password|passwd|secret|api_?key|access_?token|refresh_?token|private_?key|encryption_?key)[ \t]*[:=][ \t]*["']?)(?!\[REDACTED\])[^\s"',;&}]+/gi,
    replace: keepPrefix,
  },
];

// Object keys whose string values are always secret, compared without case,
// `-` or `_`. Deliberately exact: `tokens` and `inputTokens` are usage counts.
const sensitiveKeys = new Set([
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "apikey",
  "xapikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "privatekey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "sessionsecret",
  "encryptionkey",
  "gatewaykey",
  "credential",
  "credentials",
  "totpsecret",
  "otpauthurl",
  "recoverycode",
  "recoverycodes",
]);

const isSensitiveKey = (key: string): boolean =>
  sensitiveKeys.has(key.toLowerCase().replaceAll(/[-_]/g, ""));

/** Whether `redact` copies `value` (and redacts inside it) or keeps it. */
const isCopied = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    Array.isArray(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error
  ) {
    return true;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Registered values shorter than this are ignored: they would match noise. */
export const minimumSecretLength = 4;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Redactor {
  /** Adds exact values (say, a credential just decrypted) to remove. */
  register(...secrets: readonly string[]): void;
  /** `text` with every registered value and credential shape removed. */
  redactText(text: string): string;
  /**
   * A deep copy of `value` with every string redacted and the values of
   * sensitive keys (`password`, `apiKey`, `authorization`…) replaced.
   * Arrays, plain objects, Maps, Sets and Errors are copied; other objects
   * (Dates, Buffers, class instances) are returned as they are.
   */
  redact<T>(value: T): T;
}

export interface RedactorOptions {
  readonly secrets?: Iterable<string>;
  /** Credential shapes on top of `credentialPatterns`. */
  readonly patterns?: readonly CredentialPattern[];
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const patterns = [...credentialPatterns, ...(options.patterns ?? [])];
  const forms = new Set<string>();
  let registered: RegExp | undefined;

  const register = (...secrets: readonly string[]): void => {
    for (const secret of secrets) {
      if (secret.length < minimumSecretLength) {
        continue;
      }
      // As written, inside a JSON string, and URL-encoded.
      forms.add(secret);
      forms.add(JSON.stringify(secret).slice(1, -1));
      forms.add(encodeURIComponent(secret));
    }
    registered =
      forms.size === 0
        ? undefined
        : new RegExp(
            [...forms]
              .sort((a, b) => b.length - a.length)
              .map(escapeRegExp)
              .join("|"),
            "g",
          );
  };

  const redactText = (text: string): string => {
    let result = registered ? text.replace(registered, redactedText) : text;
    for (const { pattern, replace } of patterns) {
      result = replace
        ? result.replace(pattern, replace)
        : result.replace(pattern, redactedText);
    }
    return result;
  };

  const copy = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      for (const item of value) {
        result.push(copy(item, seen));
      }
      return result;
    }
    if (value instanceof Map) {
      const result = new Map<unknown, unknown>();
      seen.set(value, result);
      for (const [key, item] of value) {
        result.set(
          key,
          typeof key === "string"
            ? copyEntry(key, item, seen)
            : copy(item, seen),
        );
      }
      return result;
    }
    if (value instanceof Set) {
      const result = new Set<unknown>();
      seen.set(value, result);
      for (const item of value) {
        result.add(copy(item, seen));
      }
      return result;
    }

    if (!isCopied(value)) {
      return value;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    const isError = value instanceof Error;
    const result = Object.create(prototype as object | null) as Record<
      string,
      unknown
    >;
    seen.set(value, result);
    const record = value as Record<string, unknown>;
    // An Error's message and stack are not enumerable, so they are named.
    const keys = isError
      ? [
          ...new Set([
            "name",
            "message",
            "stack",
            "cause",
            ...Object.keys(value),
          ]),
        ]
      : Object.keys(value);
    for (const key of keys) {
      if (!(key in record)) {
        continue;
      }
      result[key] = copyEntry(key, record[key], seen);
    }
    return result;
  };

  // A sensitive key's value is replaced. An array or Set under it (say,
  // `set-cookie: [...]`) has each item replaced; an object under it (say,
  // `credentials: { … }`) is redacted key by key.
  const copyEntry = (
    key: string,
    item: unknown,
    seen: WeakMap<object, unknown>,
  ): unknown => {
    if (!isSensitiveKey(key) || item == null) {
      return copy(item, seen);
    }
    if (Array.isArray(item)) {
      return item.map((element: unknown) => copyEntry(key, element, seen));
    }
    if (item instanceof Set) {
      return new Set([...item].map((element) => copyEntry(key, element, seen)));
    }
    return isCopied(item) ? copy(item, seen) : redactedText;
  };

  register(...(options.secrets ?? []));
  return {
    register,
    redactText,
    redact: <T>(value: T): T => copy(value, new WeakMap()) as T,
  };
}
