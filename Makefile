

.DEFAULT_GOAL := build

install:
	npm install

inspector:
	npx -y @modelcontextprotocol/inspector npx -y tsx main.ts

build: install
	npx tsc --noEmit \
		&& npx esbuild src/main.ts --bundle --platform=node --format=esm --outfile=build/main.mjs

