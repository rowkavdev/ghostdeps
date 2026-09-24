# fixture: package-json-without-js

A repository whose only package.json exists for tooling metadata (a formatter
config, repo scripts). There is no meaningful JavaScript or TypeScript source,
so JS/TS detection must score below threshold and skip this project with a
stated reason (issue #24).
