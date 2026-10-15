// AI Office's own rules for "Is this tool call safe?" (PRD FR-17: "When
// it is off, those judgements use the Manager's own Model or
// deterministic rules"). They judge every tool call and every setup
// command, whether the Decision Model is on or off, and whether Jev
// answers or not (P1-8), so a call is never let be unjudged. They are
// plain code, and catch only what is plainly unsafe for an Agent working
// an issue in its sandbox: reading or sending its credentials, reaching
// the cloud's metadata service or the host's Docker, sending data off to a
// host, running a script it downloads, opening raw connections, or
// deleting everything. Jev, when on, judges the rest. A call too long to
// be read whole is not passed, since what it holds past the part read is
// unknown.

/** The most of a tool call AI Office's rules and Jev read: the whole of it. */
export const maxScreenedCall = 100_000;

/**
 * The sandbox's variables that hold a credential: its read-only GitHub
 * token and its Agent's Gateway Key, as each agent tool reads them, and
 * the names an AI Provider's own key goes by, which a sandbox never holds.
 */
export const credentialVariables = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "AI_OFFICE_GATEWAY_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_CONFIG_CONTENT",
] as const;

/** The tools that run what they are given in a shell. */
const shellTools = new Set(["Bash", "bash", "Setup"]);

const credentialExpansion = new RegExp(
  `\\$\\{?(?:${credentialVariables.join("|")})\\b`,
);
const variableNamed = new RegExp(
  `\\b(?:printenv|getenv)\\b[^;&|\\n]*\\b(?:${credentialVariables.join("|")})\\b`,
);

/** Hosts a call may send data to: the sandbox itself. */
const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i;

/** The hosts a command names, by URL or as a bare domain or address. */
const hostsIn = (command: string): string[] =>
  [
    ...command.matchAll(
      /(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s@/'"]+@)?(\[[0-9a-f:]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(?::\d+)?/gi,
    ),
  ]
    .map((match) => match[1] ?? "")
    // A file such as `data.json` names no host.
    .filter(
      (host) =>
        /^\[|^localhost$|^\d+(?:\.\d+){3}$/i.test(host) ||
        /\.(?:[a-z]{2,})$/i.test(host),
    )
    .filter(
      (host) => !/\.(?:json|txt|md|ts|js|sh|ya?ml|csv|log|env)$/i.test(host),
    );

interface Rule {
  /** What the call does, as "it …". */
  readonly does: string;
  /** Which tools it applies to; all by default. */
  readonly shellOnly?: boolean;
  readonly matches: (args: string) => boolean;
}

const rules: readonly Rule[] = [
  {
    does: "reads the sandbox's credentials",
    shellOnly: true,
    matches: (args) =>
      credentialExpansion.test(args) || variableNamed.test(args),
  },
  {
    does: "reads the whole environment, where the sandbox's credentials are",
    matches: (args) =>
      /\/proc\/[^\s/'"]*\/environ\b/.test(args) ||
      /\bprintenv\s*(?:$|[;&|>)])/m.test(args) ||
      /(?:^|[;&|(`]|\$\()\s*(?:env|export\s+-p|declare\s+-x|set)\s*(?:$|[;&|>)`])/m.test(
        args,
      ),
  },
  {
    does: "reaches the cloud's metadata service",
    matches: (args) =>
      /169\.254\.169\.254|\bfd00:ec2::254\b|metadata\.google\.internal/i.test(
        args,
      ),
  },
  {
    does: "reaches the host's Docker",
    matches: (args) => /docker\.sock\b|\bnsenter\b/.test(args),
  },
  {
    does: "runs a script it downloads",
    shellOnly: true,
    matches: (args) =>
      /\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+)?(?:env\s+)?(?:ba|da|z|k)?sh\b/.test(
        args,
      ) ||
      /\b(?:ba|da|z|k)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/.test(args) ||
      /\b(?:ba|da|z|k)?sh\s+<\(\s*(?:curl|wget)\b/.test(args),
  },
  {
    does: "sends data to a host other than the sandbox",
    shellOnly: true,
    matches: (args) =>
      (/\bcurl\b[^\n;|]*\s(?:-[a-zA-Z]*[dFT]\b|--data(?:-binary|-raw|-urlencode|-ascii)?\b|--form\b|--upload-file\b|--json\b)/.test(
        args,
      ) ||
        /\bwget\b[^\n;|]*--(?:post|body)-(?:data|file)\b/.test(args)) &&
      hostsIn(args).some((host) => !loopback.test(host)),
  },
  {
    does: "opens a raw connection",
    shellOnly: true,
    matches: (args) =>
      /\/dev\/(?:tcp|udp)\//.test(args) ||
      /(?:^|[;&|(`\s])(?:nc|ncat|netcat|socat|telnet)\s/m.test(args),
  },
  {
    does: "scans the network",
    shellOnly: true,
    matches: (args) => /(?:^|[;&|(`\s])(?:nmap|masscan|zmap)\s/m.test(args),
  },
  {
    does: "deletes everything",
    shellOnly: true,
    matches: (args) =>
      /\brm\s+(?:-[a-zA-Z]+\s+)*(?:--no-preserve-root\s+)?(?:-[a-zA-Z]+\s+)*(?:\/\*?|~\/?\*?|\$HOME\/?\*?)(?:\s|$|;|&)/.test(
        args,
      ) && /\brm\s+[^;&|\n]*-[a-zA-Z]*r/.test(args),
  },
];

/**
 * Why AI Office's rules judge a call unsafe, or a setup command (named
 * `Setup`); undefined when they find nothing unsafe in it.
 */
export function toolCallRules(call: {
  readonly name: string;
  readonly args: string;
}): string | undefined {
  const name = call.name.slice(0, 100);
  if (call.args.length > maxScreenedCall) {
    return `AI Office's rules do not pass a ${name} call too long to read whole (${call.args.length.toLocaleString("en-GB")} characters)`;
  }
  const shell = shellTools.has(call.name);
  const broken = rules.find(
    (rule) => (shell || rule.shellOnly !== true) && rule.matches(call.args),
  );
  return broken === undefined
    ? undefined
    : `AI Office's rules judged a ${name} call unsafe: it ${broken.does}`;
}
