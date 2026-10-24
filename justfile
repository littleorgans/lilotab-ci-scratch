set shell := ["bash", "-euo", "pipefail", "-c"]

# Private publishing recipes are absent from public snapshots.
import? 'publish/publish.just'

name := `node -p "require('./package.json').name"`
version := `node -p "require('./package.json').version"`
zip := "release/" + name + "-" + version + ".zip"

# Only the vite-plus binary from npm ci; npx would fetch or reuse an unrelated `vp` package
vp := "./node_modules/.bin/vp"
tsc := "./node_modules/.bin/tsc"

# List recipes
default:
    @just --list

# Install the exact dependencies in package-lock.json
install:
    npm ci

# Vite dev server with CRXJS hot reload; load dist/ unpacked in a test profile
dev:
    {{ vp }} dev

# Release build into dist/, zipped to release/<name>-<version>.zip
build:
    {{ vp }} build
    mkdir -p release
    cd dist && zip -qrX -FS ../{{ zip }} .
    @echo {{ zip }}

# Measurement build into dist-timing/, unzipped: the release build plus the gesture timing log, read and exported on
# the options page. Its own folder, so `just build` never overwrites it. Never ship it.
build-timing:
    {{ vp }} build --mode timing --outDir dist-timing

# Release build, then the headless Chrome harness over dist/; output in .smoke/runs/<UTC time>, nonzero exit on any FAIL.
# Fetches the pinned Chrome for Testing into .smoke/browsers on first use. Diagnose with --only <scenario id substring>;
# --chrome <executable> replaces the pinned browser.
smoke *args: build
    node test/chrome/run.mjs --ext dist --out .smoke/runs/$(date -u +%Y%m%dT%H%M%SZ) {{ args }}

# Apply the safe format and lint fixes, then format check, lint (including the core purity rules) and typecheck of the core, app and node projects
check: && typecheck
    {{ vp }} check --fix

# Typecheck every tsconfig project on its own: vp check misses node project errors in the src files tests import
typecheck:
    {{ tsc }} -b

# Run the test suite once
test:
    {{ vp }} test

# Fail when a tracked path is neither allowlisted nor private for publishing; public snapshots have no publish/ and skip it
classify:
    [ ! -f publish/cli.mjs ] || node publish/cli.mjs check

# The strict check is a body line, so `&&` runs typecheck, test and build after it
# Everything CI runs, checking without fixing; the workflow calls only this recipe
ci: classify install && typecheck test build
    {{ vp }} check
