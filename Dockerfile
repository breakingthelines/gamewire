# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json bun.lock* .npmrc ./
RUN --mount=type=secret,id=gh_pkg_token \
    sh -eu -c 'token="$(cat /run/secrets/gh_pkg_token)" && \
      printf "//npm.pkg.github.com/:_authToken=%s\n" "$token" > /root/.npmrc && \
      GH_PKG_TOKEN="$token" bun install --frozen-lockfile --production && \
      rm -f /root/.npmrc'

COPY src/ ./src/
COPY tsconfig.json ./

RUN chown -R bun:bun /app

USER bun

EXPOSE 8095

CMD ["bun", "run", "src/worker/server.ts"]
