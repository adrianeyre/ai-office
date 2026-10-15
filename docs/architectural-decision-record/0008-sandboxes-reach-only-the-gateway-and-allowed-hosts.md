# Sandboxes reach only the AI Gateway and the hosts the Owner allows

An Agent's sandbox runs code that text an attacker wrote may have steered, and it holds the repository, a read-only `GH_TOKEN` and the Agent's Gateway Key. The pen-test round found that it could send all three anywhere (S2-1), reach the instance metadata service on EC2 (S2-2), and reach the app's sign-in routes as well as the Gateway (S2-3). So sandboxes are started on a Docker network with no route out (`internal`), which the app is not on. The one other container on it is the **sandbox relay** (`docker/sandbox-relay/relay.ts`). It forwards one port to the AI Gateway, and is an HTTPS proxy to the hosts the Owner names in `SANDBOX_EGRESS_HOSTS`, port 443 only, never to an IP address and never to a name that resolves to a link-local, loopback or metadata address. The sandbox images name it as their `HTTPS_PROXY`. Under compose the relay is a service of the stack. Outside it, `docker-compose.dev.yml` starts the same relay and network, which `SANDBOX_NETWORK` names by default, and the relay reaches the Gateway on the host.

## Considered Options

- **Firewall rules on the host** (`iptables` in `DOCKER-USER`): they hold for any container, but AI Office would have to write the host's firewall from a container, and they differ between Linux, Docker Desktop and the EC2 set-up.
- **No egress at all**: the simplest, but Floors whose setup command installs packages, and `gh` reading the Agent's issue, would stop working.
- **The app as the relay, on the sandboxes' network**: no new container, but then the app is on that network, and keeping its web app, API and sign-in callback off it would mean binding each listener to one network's address, which Docker assigns.
- **A proxy image such as Squid or tinyproxy**: a full proxy, but a second image to pin and patch, and a configuration language to review. The relay is about 300 lines of Node, run from the Node image the stack already uses, and tested here.

## Consequences

- `SANDBOX_GATEWAY_URL` is `http://sandbox-relay:3047`, under compose and outside it. `SANDBOX_NETWORK` defaults to `ai-office-sandboxes`, never Docker's default bridge.
- `SANDBOX_EGRESS_HOSTS` is the Owner's decision. `.env.example` lists `registry.npmjs.org` and `api.github.com`, and empty means none. Each listed host is one an injected Agent could send what it read to, if it holds an account there, so the list stays short.
- The Manager's chat sessions, fact-finding sandboxes and subscription model calls run on the same network, so they too reach only the Gateway and the allowed hosts. Their web search runs at the AI Provider, through the Gateway, as before. Their web fetch (ADR 0004: the chat "reads … the web") now reaches only the allowed hosts.
- Plain HTTP and other ports are not relayed. A Floor whose work needs them (a private registry over HTTP, `git` over SSH) needs a new decision.
- Each connection a sandbox asks for, relayed or refused, is a line in the relay's log.
- AI Office sets each sandbox's proxy variables itself (`proxyEnvironment` in `packages/orchestrator/src/sandbox/environment.ts`), not only the images: the Docker CLI sets them in every container from its own proxy configuration (Docker Desktop's settings, a company's `~/.docker/config.json`), over the image's, and a `NO_PROXY` that does not name the relay sent the agent tool's model calls to the relay's proxy, which refused them. Claude Code's non-essential traffic (telemetry, error reports, update checks) is switched off, as the relay would refuse it.
- Running AI Office both under compose and outside it on one machine is not supported: each has its own relay on the one `ai-office-sandboxes` network.
