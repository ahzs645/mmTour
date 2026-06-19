# Tooling

This directory contains only tools that are used by the current extraction and
verification pipeline.

- `ffdec-runtime/ffdec_26.0.0/` supplies FFDec/JPEXS CLI files used by
  `scripts/export-ffdec.mjs` and `scripts/verify-artifacts.mjs`.
- `flasm-src/` is the vendored Flasm source used by `npm run build:flasm`.
- `flasm-bin/` is the local Flasm output consumed by
  `scripts/build-secondary-cli-reports.mjs`.

Large reference checkouts that are not called by active scripts should not live
in this repo. Keep those as external links or archive branches instead.
