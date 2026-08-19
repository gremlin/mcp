
.DEFAULT_GOAL := build

install: hooks
	npm install

hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push

inspector:
	npx -y @modelcontextprotocol/inspector npx -y tsx src/main.ts

build: install
	npx tsc --noEmit \
		&& npx esbuild src/main.ts --bundle --platform=node --format=esm --banner:js='#!/usr/bin/env node' --outfile=build/main.mjs \
		&& chmod +x build/main.mjs

test: build
	npx vitest run

publish: test
	npm publish

bump:
	@node scripts/bump-version.mjs $(VERSION)
