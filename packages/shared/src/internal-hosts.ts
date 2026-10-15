import { z } from "zod";

// Addresses the Owner gives AI Office to reach (pen-test findings I1-1 to
// I1-3, H13; ADR 0007): a custom AI endpoint, the outbound proxy, a
// Connection's webhook, ntfy server, Confluence site or SMTP server, and a
// Skill's or Floor Template's Git repository. None of them may name a
// loopback, link-local or private address, or a name that only resolves
// inside the Owner's network or the stack's own (`app`, `postgres`,
// `*.internal`), unless the host is one the Owner allowed in the
// environment, in ALLOWED_INTERNAL_HOSTS: a stolen session cannot change
// the environment. Plain http:// is likewise only for an allowed host, such
// as the Owner's own Ollama. The server sets the hosts at start; the web
// app learns them with its session, so its forms agree. What a name
// resolves to is checked where the fetch is made
// (`@ai-office/shared/internal-hosts-guard`).

/** The environment variable that names the hosts the Owner allows. */
export const allowedInternalHostsVariable = "ALLOWED_INTERNAL_HOSTS";

/** The most hosts it may name. */
export const maxAllowedInternalHosts = 50;

/**
 * A host the Owner allows: a name (`ollama.lan`, which also covers its
 * subdomains), a domain (`.lan`), or an IP address, without a port.
 */
export const allowedInternalHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[0-9a-f:]*:[0-9a-f:.]+)$/, {
    error:
      "must name hosts (ollama.lan), domains (.lan) or IP addresses, without ports, separated by commas",
  });

/** The hosts allowed, as the server was started with them. */
let allowed: readonly string[] = [];

/** Sets the hosts allowed: the server's at start, the web app's with its session. */
export function allowInternalHosts(hosts: readonly string[]): void {
  allowed = hosts.map((host) => bare(host));
}

/** The hosts allowed now. */
export const allowedInternalHosts = (): readonly string[] => allowed;

/** A host as compared: lower-case, without IPv6 brackets or a final dot. */
const bare = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/** An IPv4 address's four bytes, or undefined for anything else. */
const ipv4Bytes = (host: string): number[] | undefined => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return undefined;
  }
  const bytes = host.split(".").map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
};

/** An IPv6 address's eight 16-bit groups, or undefined for anything else. */
const ipv6Groups = (host: string): number[] | undefined => {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) {
    return undefined;
  }
  let text = host;
  // A dotted IPv4 address at the end (`::ffff:127.0.0.1`) is two groups.
  const dotted = /(?<=:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const bytes = ipv4Bytes(dotted[1]);
    if (bytes === undefined) {
      return undefined;
    }
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === "") {
      return [];
    }
    const groups = part.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
      ? groups.map((group) => parseInt(group, 16))
      : undefined;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === undefined || rest === undefined) {
    return undefined;
  }
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== 8 : given > 7) {
    return undefined;
  }
  return [...head, ...Array<number>(8 - given).fill(0), ...rest];
};

/**
 * Whether an IPv4 address is loopback, link-local, private or otherwise
 * not a public host's: this network, 10/8, the carrier-grade NAT range,
 * 127/8, 169.254/16 (the cloud metadata service), 172.16/12, 192.0.0/24,
 * 192.168/16, the benchmarking range, multicast and reserved.
 */
const internalIpv4 = ([a = 0, b = 0]: readonly number[]): boolean =>
  a === 0 ||
  a === 10 ||
  (a === 100 && b >= 64 && b <= 127) ||
  a === 127 ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  a >= 224;

/** The IPv4 address in two 16-bit groups. */
const embedded = (high = 0, low = 0): number[] => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

/**
 * Whether `host` is an IP address that is not a public host's (IPv4 as
 * above; IPv6 unspecified, loopback, unique-local, link-local, multicast,
 * and an IPv4 address carried in one, mapped, NAT64 or 6to4). False for a
 * name.
 */
export function isInternalAddress(host: string): boolean {
  const address = bare(host);
  const v4 = ipv4Bytes(address);
  if (v4 !== undefined) {
    return internalIpv4(v4);
  }
  const v6 = ipv6Groups(address);
  if (v6 === undefined) {
    return false;
  }
  const [first = 0, second = 0] = v6;
  const zeros = (count: number) => v6.slice(0, count).every((g) => g === 0);
  return (
    // ::/96 (unspecified, loopback and the old IPv4-compatible form) and
    // ::ffff:0:0/96 (IPv4-mapped).
    (zeros(6) || (zeros(5) && v6[5] === 0xffff)
      ? internalIpv4(embedded(v6[6], v6[7]))
      : false) ||
    // 64:ff9b::/96, NAT64.
    (first === 0x64 && second === 0xff9b && v6.slice(2, 6).every((g) => g === 0)
      ? internalIpv4(embedded(v6[6], v6[7]))
      : false) ||
    // 2002::/16, 6to4.
    (first === 0x2002 ? internalIpv4(embedded(v6[1], v6[2])) : false) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

/** Whether `host` is an IP address, of either family. */
export const isIpAddress = (host: string): boolean =>
  ipv4Bytes(bare(host)) !== undefined || ipv6Groups(bare(host)) !== undefined;

/**
 * Suffixes of names that only resolve inside a network: the reserved and
 * customary private ones.
 */
const internalSuffixes = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
];

/**
 * Whether `host` names somewhere inside a network, by its form alone: an
 * internal IP address, `localhost`, a single label (`app`, `postgres`,
 * which resolve on the stack's own network) or a private suffix
 * (`metadata.google.internal`, `nas.lan`).
 */
export function isInternalHost(host: string): boolean {
  const name = bare(host);
  if (isIpAddress(name)) {
    return isInternalAddress(name);
  }
  return (
    !name.includes(".") ||
    internalSuffixes.some(
      (suffix) => name === suffix || name.endsWith(`.${suffix}`),
    )
  );
}

/**
 * Whether the Owner allowed `host`: it is a name they listed or under a
 * domain they listed, or an address they listed.
 */
export function isAllowedHost(
  host: string,
  hosts: readonly string[] = allowed,
): boolean {
  const name = bare(host);
  const v6 = ipv6Groups(name)?.join(":");
  return hosts.some((entry) => {
    const listed = bare(entry);
    if (v6 !== undefined) {
      return ipv6Groups(listed)?.join(":") === v6;
    }
    const domain = listed.replace(/^\./, "");
    return name === domain || name.endsWith(`.${domain}`);
  });
}

/** What to tell the Owner about a host that is internal and not allowed. */
export const internalHostProblem = (what: string, host: string): string =>
  `${what} is on an internal address (${bare(host)}), which AI Office reaches only if ${allowedInternalHostsVariable} names it.`;

/** How an address the Owner gives is checked. */
export interface OwnerUrlOptions {
  /** The hosts allowed; the server's by default. */
  readonly hosts?: readonly string[];
  /**
   * Whether plain http:// is fine for any host: for a forward proxy, which
   * carries https:// requests inside its own connection.
   */
  readonly plainHttp?: boolean;
}

/**
 * Why AI Office may not fetch `value`, an address the Owner gives, or
 * undefined when it may: an internal host the Owner did not allow, or
 * plain http:// to one they did not.
 */
export function ownerUrlProblem(
  value: string,
  what: string,
  options: OwnerUrlOptions = {},
): string | undefined {
  const hosts = options.hosts ?? allowed;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (isAllowedHost(url.hostname, hosts)) {
    return undefined;
  }
  if (isInternalHost(url.hostname)) {
    return internalHostProblem(what, url.hostname);
  }
  return url.protocol === "http:" && options.plainHttp !== true
    ? `${what} is https://; http:// is only for a host ${allowedInternalHostsVariable} names.`
    : undefined;
}

/**
 * A refinement for an address the Owner gives (`what` names it in the
 * message): see `ownerUrlProblem`.
 */
export const ownerUrl =
  (what: string, options: Omit<OwnerUrlOptions, "hosts"> = {}) =>
  (value: string, context: z.RefinementCtx): void => {
    const problem = ownerUrlProblem(value, what, options);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", message: problem });
    }
  };

/**
 * A refinement for a host the Owner gives with no URL around it (an SMTP
 * server's): see `ownerUrlProblem`; there is no scheme to check.
 */
export const ownerHost =
  (what: string) =>
  (value: string, context: z.RefinementCtx): void => {
    if (!isAllowedHost(value) && isInternalHost(value)) {
      context.addIssue({
        code: "custom",
        message: internalHostProblem(what, value),
      });
    }
  };
