# syntax=docker/dockerfile:1
# The development image `pnpm dev` runs the server and Vite in
# (docker-compose.dev.yml): Node, pnpm, git and the Docker CLI, and no
# sources. The repository is bind-mounted at /app, so a change on the host
# restarts the server or reloads the web app; each workspace package's
# node_modules is a volume of its own, installed inside the container, so
# the host's node_modules (for another platform, say) is never used or
# touched. The versions and digests are the root Dockerfile's, which
# docker/supply-chain.pen-test.test.ts keeps in step.
ARG NODE_VERSION=26.10.0
ARG DOCKER_CLI_VERSION=29.5.3

FROM docker:${DOCKER_CLI_VERSION}-cli@sha256:11e1133c30f3ceb73c6bdc7dfb78b3f9ed8e8e0d1d0400e91c5ec2eb240bf2ff AS docker-cli

FROM node:${NODE_VERSION}-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33
# pnpm, at the exact version docker/pnpm/package.json names, checked by npm
# against the SHA-512 its package-lock.json records.
COPY docker/pnpm/package.json docker/pnpm/package-lock.json /opt/pnpm/
RUN npm ci --prefix /opt/pnpm --omit=dev --no-audit --no-fund \
  && npm cache clean --force
ENV PATH="/opt/pnpm/node_modules/.bin:${PATH}"
# git, for the clones Agents and the Manager chat work in, and the Docker
# CLI, for their sandboxes (the Docker daemon is the host's).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# The containers run as the host user that runs `pnpm dev` (so files they
# write in the repository, and Agents' clones, are that user's), whose UID
# the image cannot know: the volumes' mount points, which Docker copies
# into each new volume, are writable by anyone. A new workspace package
# needs its node_modules here and in docker-compose.dev.yml.
RUN mkdir -p /pnpm-store \
    /app/node_modules \
    /app/apps/server/node_modules \
    /app/apps/web/node_modules \
    /app/packages/communications/node_modules \
    /app/packages/db/node_modules \
    /app/packages/events/node_modules \
    /app/packages/gateway/node_modules \
    /app/packages/github/node_modules \
    /app/packages/orchestrator/node_modules \
    /app/packages/shared/node_modules \
    /app/e2e/node_modules \
  && chmod 1777 /pnpm-store /app/node_modules /app/*/*/node_modules /app/e2e/node_modules
ENV HOME=/tmp
WORKDIR /app
