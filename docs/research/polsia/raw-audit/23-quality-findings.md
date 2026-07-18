# Quality findings from exported project

## Biome lint

All five findings are confined to the generated `src/app/(setup)/page.tsx` landing page:

- Import ordering/formatting.
- Two decorative SVGs lack title metadata; either add accessible titles where the SVG conveys meaning or add a deliberate accessibility suppression where `aria-hidden="true"` is the intended behavior.
- One array-index React key; use a stable coordinate-derived key instead.
- Remaining diagnostics are formatter output.

These findings do not prevent the production build, but the SVG and key issues should be resolved before shipping.

## npm advisory

The single high advisory is development-only and transitive:

- `jsdom@26.0.0` → `form-data@4.0.5`.
- Advisory: CRLF injection via unescaped multipart field names/filenames, `GHSA-hmw2-7cc7-3qxx`.
- `npm audit --omit=dev` returns **0 vulnerabilities**, so the production dependency graph is clean.
- Dry-run remediation updates `form-data` to `4.0.6` and `hasown` to `2.0.4` without a major-version upgrade.

No dependency files were changed; this was inspection only.
