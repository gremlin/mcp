
.DEFAULT_GOAL := build

# build and test rely on their prerequisites running in order.
.NOTPARALLEL:

.PHONY: install hooks inspector build compile typecheck bundle \
        test unit-test ci-install ci-unit-test publish bump

install: hooks
	npm install

hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push

inspector:
	npx -y @modelcontextprotocol/inspector npx -y tsx src/main.ts

build: install compile

test: build unit-test

publish: test
	npm publish

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
