# Supply-chain artifacts (D1b, TECH-D §3.1)

Generated 2026-07-31 at pin `95c1ab81f31f318a9e344d1d229feacff861ad39` plus the
four D1b patch commits on `crd/d1b-patches`. Superseded the D1a spike's manual
`cargo tree` traversal with the actual tooling TECH-D §3.1 calls for.

## Tooling and exact invocations

- **`cargo-cyclonedx` 0.5.9** (`cargo install cargo-cyclonedx --locked`):
  ```
  cargo cyclonedx --manifest-path frontend/wrapper/Cargo.toml \
    --target wasm32-unknown-unknown --no-build-deps \
    --format json --spec-version 1.5
  ```
  `--target wasm32-unknown-unknown --no-build-deps` scopes the SBOM to the
  runtime dependency closure actually shipped in the wasm binary -- the same
  scoping the D1a evidence's manual `cargo tree -e normal --target
  wasm32-unknown-unknown` traversal argued for, now produced by the tool
  TECH-D §3.1 names instead of hand-verification. The tool emits one file per
  workspace member; only `frontend/wrapper/graphite-wasm-wrapper.cdx.json`
  (the crate that becomes the shipped `.wasm` artifact) is kept here as
  `graphite-wasm-wrapper.cdx.json` -- the other ~50 per-crate files it
  scatters across the workspace (editor, desktop, every node-graph crate,
  internal tools) are not runtime dependencies of what we serve and were
  discarded.
- **`@cyclonedx/cyclonedx-npm` 6.0.0** (via `npx`):
  ```
  npx @cyclonedx/cyclonedx-npm --output-format json \
    --output-file cyclonedx-npm.cdx.json --omit dev
  ```
  `--omit dev` scopes this to the frontend's production dependency set, saved
  here as `frontend-npm.cdx.json`.
- **`cargo-audit` 0.22.2**: `cargo audit --json` → `cargo-audit.json`
  (workspace-wide; there is no per-target audit mode).
- **`npm audit`** in `frontend/`: `--omit=dev --json` →
  `npm-audit-production.json` (what's actually in the shipped bundle) and
  the unscoped `--json` → `npm-audit-full.json` (includes build/dev tooling,
  for completeness).

## Findings

### `graphite-wasm-wrapper.cdx.json` (284 components, wasm32 runtime closure)

**Zero GPL/LGPL/AGPL/MPL** license expressions found (checked every
`licenses[].expression` across all 284 components) -- every component is
MIT, Apache-2.0, BSD-2/3-Clause, Zlib, CC0-1.0, Unicode-3.0, 0BSD, Unlicense,
or BSL-1.0 (Boost, permissive), alone or in an OR-combination. This is the
formal confirmation of the D1a evidence's finding that `option-ext@0.2.0`
(MPL-2.0) is absent from this closure -- it only ever showed up via
build-dependency edges (`--no-build-deps` here excludes it by construction,
matching the manual `-e normal` traversal's result).

### `frontend-npm.cdx.json` (7 components, npm production deps)

A static SPA has almost no npm *runtime* dependencies (bundling happens at
build time) -- the 7 listed are `@wasm-tool` runtime shims (MIT), `tslib`
(0BSD), and the two vendored demo fonts, `source-code-pro` (OFL-1.1) and
`source-sans-pro` (SIL OFL 1.1). No GPL/LGPL/AGPL/MPL findings.

### `cargo-audit.json` (workspace-wide, 20 advisories + 11 unmaintained/unsound/yanked warnings)

Unchanged in substance from the D1a evidence's findings (this spike's patches
touch no dependency versions). Notably still present in the wasm32 runtime
closure via `reqwest`/`http` (the font-catalog fetch client, now pointed
same-origin by this increment's font-vendoring patch): **`bytes v1.10.1`**
(RUSTSEC-2026-0007, integer overflow in `BytesMut::reserve`, high severity,
fix: upgrade to >=1.11.1). Recommended at the next pin advance (TECH-D §8);
not something D1b's patches should force a dependency bump for on their own,
since that reopens the wider `Cargo.lock` diff outside this increment's
scope. `aws-lc-sys`/`quinn-proto`/`rustls-webpki` remain confirmed absent
from the wasm32 normal closure per the evidence's prior traversal.

### `npm-audit-production.json` -- **0 vulnerabilities**

Confirms the D1a evidence's conclusion: the 7 advisories visible in an
unscoped `npm audit` (`npm-audit-full.json`) are all in `postcss`/`vite`
(build-time/dev-server only) or `svelte` (SSR-only XSS; this is a
client-rendered SPA with no SSR) -- none apply to the static production
bundle actually served.

## What this does NOT cover

- **Reproducible-build receipt** and **lifecycle-script review**: carried
  forward unchanged from `d1a-evidence.md` (no new lifecycle scripts or
  build-determinism concerns were introduced by these patches).
- **Bundled-asset audit**: unchanged from the evidence (demo-artwork samples
  and the two vendored fonts, inventoried above).
- A pin-advance SBOM re-run (TECH-D §8) is required at the next pin move,
  same as any other pinned dependency.
