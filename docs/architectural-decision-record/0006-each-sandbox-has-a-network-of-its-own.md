# Each sandbox has a network of its own

ADR 0008 put every sandbox on one internal network, `ai-office-sandboxes`, with the sandbox relay as the only other container on it. The pen-test round found that on that network one sandbox reaches any port another opens, of its own Floor or another's, such as a dev server or test database a Floor's setup command starts (S2-5). Turning inter-container traffic off on it would cut the sandboxes off from the relay as well, and so from the AI Gateway. So each container AI Office starts for an Agent (a task's sandbox, a Grilling Session's fact-finding, a Manager chat session, a subscription's model call) is started on a network of its own: internal, created just before it, and removed just after. AI Office joins the sandbox relay to that network under the name `sandbox-relay`. Only two containers are ever on it, the sandbox and the relay, so the sandbox reaches the Gateway and the relay's proxy at the same names as before, and no other sandbox.

`SANDBOX_NETWORK` (default `ai-office-sandboxes`) now names the network the relay is on. AI Office finds the relay there by its compose service, `sandbox-relay`. No sandbox joins that network any more, and inter-container traffic is off on it.

## Considered Options

- **Inter-container traffic off on the one network, and the Gateway reached another way** (the relay on the host's network, or published at the bridge's own address): the relay would then be outside Docker's networks, which differ between Linux, Docker Desktop and the EC2 set-up, and an internal network's route to the host's address is not the same on every Docker version (ADR 0008 already relies on not needing it).
- **A relay per sandbox**: a second container for every sandbox, and a model call through a subscription would start two containers.
- **A network per Floor**: one Floor's sandboxes would still reach each other, and the finding is "of its own Floor or another's".
- **Firewall rules on the host**: rejected in ADR 0008 for the same reasons.

## Consequences

- Each sandbox's network is `ai-office-sandbox-<uuid>`, labelled `ai-office.sandbox-network=<SANDBOX_NETWORK>`. It is removed when the sandbox is. Networks a crashed AI Office left behind are removed the next time it starts a sandbox, so Docker's address pools do not run out.
- A sandbox cannot start unless the sandbox relay is running on `SANDBOX_NETWORK`. It fails at once, saying so, where before it started and then could not reach the Gateway.
- Starting a sandbox costs a `docker network create` and a `docker network connect`, and stopping one a disconnect and a remove. That cost falls on every Manager chat turn and every subscription model call too.
- The images, `SANDBOX_GATEWAY_URL` (`http://sandbox-relay:3047`) and the relay itself are unchanged. The relay is on every running sandbox's network, so it still reaches none of them: its Gateway port forwards only to the Gateway, and its proxy only to the hosts `SANDBOX_EGRESS_HOSTS` names.
- Running AI Office both under compose and outside it on one machine is still not supported (ADR 0008). Each would find its own relay, but both would remove the other's leftover networks.
