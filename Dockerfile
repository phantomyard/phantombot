# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for phantombot.
#
# Stages:
#   deps      — install JS dependencies (cached layer)
#   source    — deps + project source (basis for test/typecheck/build)
#   test      — runs `bun test`
#   typecheck — runs `bun tsc --noEmit`
#   build     — runs `bun build --compile` to produce dist/phantombot
#
# The compiled binary is glibc-based (target bun-linux-x64). Stay on the
# Debian-based oven/bun image to keep ABI compatibility.

ARG BUN_VERSION=1.1.38

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bunfig.toml ./
# bun.lockb may not exist on first build; the trailing * tolerates absence.
COPY bun.lockb* ./
RUN bun install

FROM deps AS source
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY agents ./agents

FROM source AS test
CMD ["bun", "test"]

FROM source AS typecheck
CMD ["bun", "tsc", "--noEmit"]

FROM source AS build
RUN mkdir -p dist
CMD ["sh", "-c", "bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile dist/phantombot && ls -lah dist/phantombot"]
