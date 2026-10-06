# The runtime base. gremlin/node:24 is Gremlin's internal image and is not publicly pullable;
# outside Gremlin pass any image whose entrypoint is node, e.g.
#   make docker-build BASE_IMAGE=cgr.dev/chainguard/node:latest
ARG BASE_IMAGE=gremlin/node:24

# Build on native arch: the bundle is platform-independent JavaScript
FROM --platform=$BUILDPLATFORM node:24.21.0-alpine AS build
WORKDIR /app
RUN apk add --no-cache make
COPY package.json package-lock.json Makefile ./
RUN make ci-install
COPY tsconfig.json ./
COPY src ./src
RUN make bundle

# esbuild inlines every dependency, so the bundle is the whole application: no node_modules.
# No RUN below this line, so a multi-arch build needs no emulation.
FROM ${BASE_IMAGE}
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/build/http.mjs ./http.mjs

EXPOSE 8080
CMD ["http.mjs"]
