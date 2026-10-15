# syntax=docker/dockerfile:1
# The AI Office app image: the server, the AI Gateway and the built web app.
# `docker compose up` builds it (see docker-compose.yml). The Node and pnpm
# versions (pnpm's in docker/pnpm/package.json) are pinned exactly and must
# meet the minimums in package.json; docker/deployment.test.ts checks that
# they do. Each base image is pinned by digest as well: the digest is what
# is pulled, so a tag re-pointed at other code changes nothing, and a new
# NODE_VERSION or DOCKER_CLI_VERSION needs its digest too (`docker buildx
# imagetools inspect node:26.10.0-slim` prints it).
ARG NODE_VERSION=26.10.0
# The Docker CLI the app starts Agents' sandboxes with, on the host's
# Docker through the socket compose mounts: the static binary from Docker's
# own image.
ARG DOCKER_CLI_VERSION=29.5.3

FROM docker:${DOCKER_CLI_VERSION}-cli@sha256:11e1133c30f3ceb73c6bdc7dfb78b3f9ed8e8e0d1d0400e91c5ec2eb240bf2ff AS docker-cli

FROM node:${NODE_VERSION}-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS base
# pnpm, at the exact version docker/pnpm/package.json names, checked by npm
# against the SHA-512 its package-lock.json records, never a version the
# registry answers with today.
COPY docker/pnpm/package.json docker/pnpm/package-lock.json /opt/pnpm/
RUN npm ci --prefix /opt/pnpm --omit=dev --no-audit --no-fund \
  && npm cache clean --force
ENV PATH="/opt/pnpm/node_modules/.bin:${PATH}"
WORKDIR /app

# Every workspace package's manifest, so the install below is cached until
# a dependency changes. A new workspace package needs a line here.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/communications/package.json packages/communications/
COPY packages/db/package.json packages/db/
COPY packages/events/package.json packages/events/
COPY packages/gateway/package.json packages/gateway/
COPY packages/github/package.json packages/github/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/

# The pnpm store is a build cache mount, which pnpm cannot hard-link from,
# so packages are copied out of it (rather than pnpm making a second store
# inside node_modules).

# Builds the web app.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --store-dir=/pnpm/store --config.package-import-method=copy
COPY . .
RUN pnpm build

# Only what the server needs at run time: its production dependencies, the
# TypeScript sources Node runs directly, the database schema, the built-in Floor
# Templates, the pricing table and the web build.
FROM manifests AS runtime
ENV NODE_ENV=production
# git, for the clones Agents and the Manager chat work in, and the Docker
# CLI, for their sandboxes (the Docker daemon is the host's).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@ai-office/server..." \
      --store-dir=/pnpm/store --config.package-import-method=copy
COPY apps/server/src apps/server/src
COPY packages/communications/src packages/communications/src
COPY packages/db/src packages/db/src
COPY packages/db/schema.sql packages/db/schema.sql
COPY templates templates
COPY packages/events/src packages/events/src
COPY packages/gateway/src packages/gateway/src
# The pricing table the AI Gateway estimates costs from.
COPY packages/gateway/pricing.json packages/gateway/pricing.json
COPY packages/github/src packages/github/src
COPY packages/orchestrator/src packages/orchestrator/src
COPY packages/shared/src packages/shared/src
COPY --from=build /app/apps/web/dist apps/web/dist

USER node
# The app (compose sets PORT=3045), which serves the AI Gateway's /v1 paths
# too; the Gateway's own port, 3047, is the sandboxes' way in and never
# published.
EXPOSE 3045
# The schema is applied to an empty database (or checked against one that
# has it) before the server starts; if that fails, the container exits and
# compose restarts it.
CMD ["sh", "-c", "node packages/db/src/apply-schema-cli.ts && exec node apps/server/src/main.ts"]
