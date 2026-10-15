# Addresses the Owner gives never reach an internal host the environment does not allow

AI Office fetches addresses the Owner types in: an AI Account's custom endpoint, the outbound proxy, a Connection's webhook, ntfy server, Confluence site or SMTP server, and the Git repository a Skill or Floor Template is imported from. The pen-test round (findings I1-1 to I1-3) showed that any of them could name the AI Office host itself, the cloud metadata service, a private address or the stack's own services (`app`, `postgres`). The custom endpoint was the worst: the AI Gateway fetched it and handed the answer to whoever held a Gateway Key, so a stolen session could add an account at `169.254.169.254` and read the instance role's credentials from a sandbox. So none of these may name a loopback, link-local or private address, a name that only resolves inside a network (one label, `localhost`, `.internal`, `.lan` and the like), or a public name that resolves to such an address, unless the host is one the Owner lists in `ALLOWED_INTERNAL_HOSTS`, in the environment. Plain `http://` is held to the same list, except for the outbound proxy, whose traffic is `https://` inside its own connection. Each address is checked when it is entered, again before it is reached, and each connection's resolved address as it is made, so a redirect or a name that answers differently the second time is caught too.

## Considered Options

- **An allow-list in Admin**, beside the setting that uses it: the Owner could change it without a restart (FR-67), but the attacker the findings name holds a stolen session, which could add the host to the list as easily as the account. The environment is out of that attacker's reach.
- **A per-account "this is on my network" switch**: the same weakness, and one more thing to get right on every form.
- **No allowance at all**: the Owner's own Ollama (FR-35), a LiteLLM or vLLM server on their network, a self-hosted ntfy or n8n, and a corporate proxy would all stop working.
- **Checking only the form of the address** (an IP literal, a private suffix): a public name pointed at `169.254.169.254` would pass. Checking what it resolves to only once, before the fetch, would let a name that answers differently the second time pass.

## Consequences

- `ALLOWED_INTERNAL_HOSTS` (comma-separated names, `.domains` or IP addresses) is read at start. The Owner's own Ollama needs `localhost` under `pnpm dev`, or `host.docker.internal` under compose; the pen-test stack allows only its stub upstream.
- The web app learns the list with its session, so its forms refuse what the server would and say which variable to set.
- An AI Account, Connection or import stored before that names a host now refused is not reached: the Gateway answers as for an account it cannot reach, a delivery fails saying why, an import fails before Git runs.
- Fetches whose host AI Office fixes itself (an AI Provider's own API, Google, Notion, Pushover, GitHub, the version check) are not held to the list.
- Through the outbound proxy, a host is checked by its form only: the proxy resolves names in its own network, which AI Office cannot see.
- Git, which resolves names itself, is pinned to the address AI Office checked, and does not follow redirects.
