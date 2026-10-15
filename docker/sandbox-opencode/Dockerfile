# The sandbox image for Agents whose AI Provider is Grok or Gemini (PRD
# FR-16, FR-19): opencode, with what it needs to work on a Floor's
# repository. Sandcastle starts a container from it per task, bind-mounts
# the issue's worktree at /home/agent/workspace and runs `opencode run` inside
# as `agent`. It reaches models only through the AI Gateway, with the
# Agent's Gateway Key, as the sandbox runner configures it from the
# environment; the image holds no credential.
#
# Built with `pnpm sandbox:build`, which tags it as the orchestrator
# expects (`opencodeSandboxImage` in packages/orchestrator) and aligns the
# `agent` user's UID and GID with the user that runs AI Office. Node and
# pnpm are the versions the root package.json pins; docker/sandbox-images.test.ts
# checks that they match. To move opencode or pnpm to another version, change
# package.json here and run `npm install --package-lock-only
# --ignore-scripts` beside it.
ARG NODE_VERSION=26.10.0

# Pinned by digest as well: the digest is what is pulled, so a tag
# re-pointed at other code changes nothing, and a new NODE_VERSION needs its
# digest too (`docker buildx imagetools inspect node:26.10.0-bookworm`).
FROM node:${NODE_VERSION}-bookworm@sha256:e6cfc3514df35d1cb534e83f9279a242ad6e578692ab7b56d73dadcc7c4354a0

# Every RUN with a pipe fails when any command in it fails.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git for the commits, curl and ca-certificates for the GitHub CLI below,
# jq for the agent's own use. Versions come with the pinned base image:
# Debian drops exact package versions as security updates land.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
  && rm -rf /var/lib/apt/lists/*

# The GitHub CLI: the Agent reads its issue with the read-only GH_TOKEN.
# One release, checked against the SHA-256 GitHub publishes for it before it
# is unpacked, never whatever an apt channel serves today.
ARG GH_VERSION=2.102.0
ARG GH_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
RUN arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
    amd64) sha256="${GH_SHA256_AMD64}" ;; \
    arm64) sha256="${GH_SHA256_ARM64}" ;; \
    *) echo "No GitHub CLI checksum for ${arch}." >&2 && exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/gh.tar.gz \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
  && printf '%s  %s\n' "${sha256}" /tmp/gh.tar.gz > /tmp/gh.tar.gz.sha256 \
  && sha256sum --check --strict /tmp/gh.tar.gz.sha256 \
  && tar -xzf /tmp/gh.tar.gz -C /usr/local/bin --strip-components=2 \
    "gh_${GH_VERSION}_linux_${arch}/bin/gh" \
  && rm /tmp/gh.tar.gz /tmp/gh.tar.gz.sha256 \
  && gh --version

# pnpm, for the Floors' own setup and test commands, and opencode: the
# exact versions package.json names, every package checked by npm against
# the SHA-512 package-lock.json records for it, never a moving tag or a
# fetched installer. Only the install scripts package.json's allowScripts
# names run. They are installed as root in /opt/agent-tools, which `agent`
# cannot change.
COPY package.json package-lock.json /opt/agent-tools/
RUN npm ci --prefix /opt/agent-tools --omit=dev --no-audit --no-fund \
  && npm cache clean --force
ENV PATH="/opt/agent-tools/node_modules/.bin:${PATH}"
# opencode never updates itself in a sandbox: it stays the version above.
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# A non-root `agent` user, with the UID and GID of the user that runs AI
# Office, so files the Agent writes in the bind-mounted worktree belong to
# that user. The base image's `node` user is renamed to `agent`.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod --non-unique --gid "${AGENT_GID}" node \
  && usermod --non-unique --uid "${AGENT_UID}" --gid "${AGENT_GID}" \
    --home /home/agent --move-home --login agent node
USER ${AGENT_UID}:${AGENT_GID}

# Where AI Office mounts the Floor's Skills, read-only (PRD FR-75), made
# as `agent` so Docker does not create its parent folders as root; and
# opencode runs, as `agent`.
RUN mkdir -p /home/agent/.config/opencode/skills && opencode --version

# The sandboxes' network has no route out (pen-testing S2-1): the internet
# is reached only through the sandbox relay's HTTPS proxy, and only the
# hosts the Owner allows (SANDBOX_EGRESS_HOSTS). The relay's own name, where
# the AI Gateway is, is reached directly.
ENV HTTPS_PROXY=http://sandbox-relay:3128 \
  https_proxy=http://sandbox-relay:3128 \
  NO_PROXY=sandbox-relay \
  no_proxy=sandbox-relay

LABEL org.opencontainers.image.title="AI Office sandbox: opencode" \
  org.opencontainers.image.description="The sandbox an AI Office Agent works in when its AI Provider is Grok or Gemini."

# Sandcastle mounts the worktree here and makes it the working directory.
WORKDIR /home/agent/workspace

# Sandcastle runs each command with `docker exec`; the container just waits.
ENTRYPOINT ["sleep", "infinity"]
