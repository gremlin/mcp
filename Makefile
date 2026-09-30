
.DEFAULT_GOAL := build

# build and test rely on their prerequisites running in order.
.NOTPARALLEL:

.PHONY: install hooks inspector build compile typecheck bundle \
        test unit-test ci-install ci-unit-test bump \
        publish npm-publish stage-publish verify-tag-version

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

bundle:
	npx esbuild src/main.ts --bundle --platform=node --format=esm \
		--banner:js='#!/usr/bin/env node' --outfile=build/main.mjs
	chmod +x build/main.mjs

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
