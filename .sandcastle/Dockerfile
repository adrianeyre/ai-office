# The sandbox image an agent runs inside.
#
# Four things Sandcastle needs and this file must keep: a non-root `agent` user
# (Claude Code refuses to run as root), `git` for the commits, `gh` for the
# issues, and `claude` on PATH. pnpm is AI Office's own addition.
#
# Node is pinned to an exact version within the root package.json's minimum.
# `engines` is a warning rather than a wall, so a sandbox on an older Node
# installs happily and then fails somewhere further in. If that minimum moves
# past this pin, move this one with it.
FROM node:26.10.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  jq \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI — the agent reads the issue it is working and comments on it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# pnpm, pinned within the workspace's `devEngines.packageManager` range. Node
# stopped shipping corepack as of 25, so pnpm is installed directly.
RUN npm install -g pnpm@12.10.0

# UID/GID alignment. `sandcastle docker build-image` defaults these to the host
# user's, so files the image writes and files the bind mount writes share an
# owner and no runtime chown is needed. A mismatch here is the cause of
# "permission denied" on a file the agent just created.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's `node` user to `agent` and align its UID/GID.
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Sandcastle bind-mounts the git worktree here and makes it the working
# directory at container start, so this has to be able to serve as the
# project root.
WORKDIR /home/agent/workspace

ENTRYPOINT ["sleep", "infinity"]
