
.DEFAULT_GOAL := build

# build and test rely on their prerequisites running in order.
.NOTPARALLEL:

.PHONY: install hooks inspector build compile typecheck bundle \
        test unit-test ci-install ci-unit-test bump \
        publish npm-publish stage-publish verify-tag-version \
        docker-build docker-run

IMAGE             ?= gremlin/mcp-server
BUILD_VERSION     ?= $(shell TZ=UTC git log -1 --date=format-local:'%Y%m%d%H%M%S' --format=%cd)
IMAGE_TAG         ?= $(BUILD_VERSION)
SOURCE_DATE_EPOCH ?= $(shell git log -1 --format=%ct)
BASE_IMAGE        ?= gremlin/node:24
PUSH              ?= false

# Pushing is opt-in rather than keyed on CI, which CircleCI sets to true in every job.
ifeq ($(PUSH),true)
DOCKER_BUILD_OPTS = --sbom=true --provenance=true --platform=linux/amd64,linux/arm64 \
	--output type=registry,rewrite-timestamp=true
else
DOCKER_BUILD_OPTS = --load
endif

install: hooks
	npm install

hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push

inspector:
	npx -y @modelcontextprotocol/inspector npx -y tsx src/main.ts

build: install compile

test: build unit-test

publish: test npm-publish

bump:
	@node scripts/bump-version.mjs $(VERSION)

ci-install:
	npm ci

typecheck:
	npx tsc --noEmit

# Two entry points: the stdio server for local clients, and the hosted HTTP server.
bundle:
	npx esbuild src/main.ts --bundle --platform=node --format=esm \
		--banner:js='#!/usr/bin/env node' --outfile=build/main.mjs
	npx esbuild src/http.ts --bundle --platform=node --format=esm \
		--banner:js='#!/usr/bin/env node' --outfile=build/http.mjs
	chmod +x build/main.mjs build/http.mjs

compile: typecheck bundle

unit-test:
	npx vitest run

ci-unit-test:
	npx vitest run --reporter=default \
		--reporter=junit --outputFile.junit=reports/junit/results.xml

verify-tag-version:
	@test -n "$$TAG" || { echo "verify-tag-version requires TAG in the environment, e.g. TAG=v2.4.3 make verify-tag-version" >&2; exit 1; }
	@node scripts/check-version-sync.mjs
	@PKG_VERSION="$$(node -p 'require("./package.json").version')"; \
	if [ "$$TAG" != "v$$PKG_VERSION" ]; then \
		echo "release tag $$TAG does not match package.json version $$PKG_VERSION (expected v$$PKG_VERSION)" >&2; \
		echo "  Run 'make bump VERSION=<major|minor|patch>' on a PR, then tag the merge commit." >&2; \
		exit 1; \
	fi; \
	echo "ok: release tag $$TAG matches package.json version $$PKG_VERSION"

npm-publish:
	npm publish --access public

# The npm Trusted Publisher is scoped to staged publishes.
stage-publish:
	npm stage publish --access public

# The hosted server's image. Builds for the local architecture and loads it; PUSH=true builds
# multi-arch and pushes instead.
docker-build:
	SOURCE_DATE_EPOCH=$(SOURCE_DATE_EPOCH) docker buildx build \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		--build-arg SOURCE_DATE_EPOCH=$(SOURCE_DATE_EPOCH) \
		-t $(IMAGE):$(IMAGE_TAG) \
		$(DOCKER_BUILD_OPTS) .

# -e takes precedence over --env-file, so a PORT in .env cannot move the server off the port being
# published.
docker-run:
	docker run --rm -p 8080:8080 --env-file .env -e PORT=8080 $(IMAGE):$(IMAGE_TAG)
