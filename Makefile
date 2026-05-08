

.DEFAULT_GOAL := build

install:
	npm install

inspector:
	npx -y @modelcontextprotocol/inspector npx -y tsx main.ts

build: install
	npx tsc --noEmit \
		&& npx esbuild src/main.ts --bundle --platform=node --format=esm --banner:js='#!/usr/bin/env node' --outfile=build/main.mjs \
		&& chmod +x build/main.mjs \
		&& npx esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=build/index.mjs \
		&& npx tsc -p tsconfig.build.json

test: build
	npx vitest run

publish: test
	npm publish

