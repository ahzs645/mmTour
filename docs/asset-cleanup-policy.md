# Asset Cleanup Policy

This workspace has several gigabyte-scale generated trees. Before making the project canonical under git, keep source inputs separate from derived outputs.

## Keep As Source

Track these files/directories:

- `src/`
- `scripts/`
- `docs/`
- `legacy/mmTour-react-ui/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vite.config.ts`
- `index.html`
- Original SWF inputs and metadata in `public/`:
  - `public/*.swf`
  - `public/*.txt`
  - `public/*.xml`
  - `public/00_A.png`
  - `public/00_B.png`

## Regenerate Instead Of Tracking

Ignore these by default:

- `dist/`
- `extracted/`
- `public/generated/`
- `verification/`
- `artifacts/`
- `.playwright-mcp/`
- `node_modules/`

The generated trees are reproducible through:

```sh
npm run convert
npm run verify:artifacts
npm run verify:runtime
```

## Notes

The app currently expects `public/generated/` to exist for the fidelity render modes. A fresh clone should either run `npm run convert` or receive generated artifacts through an explicit release/archive channel, not normal source control.
