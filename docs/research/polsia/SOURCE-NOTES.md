# Polsia Research — Source Notes

> **WARNING — evidentiary status**
>
> The Polsia audit is research evidence. It contains direct observations, first-party
> documentation, partial findings, inferences, and contradictions. The future Master PRD
> is the authoritative product source after approval.

## Provenance

| Item | Value |
| --- | --- |
| `raw-audit/` | Extracted from `polsia-audit.zip` — SHA256 `D916D3A4E852F6AD…`, 6,601,871 bytes, modified 2026-07-18 02:10 |
| `polsia-audit-review.md` | SHA256 `CB7D7DB04E548462…`, 11,494 bytes, modified 2026-07-18 02:13 |
| Import source | `C:\Users\ali_n\Downloads\` (byte-identical duplicates existed at `E:\Halo-Suite-V1\`) |
| Imported | 2026-07-18, unmodified |
| Sensitivity screen | Passed — no cookies, credentials, tokens, auth state, or private keys; all screenshots in `raw-audit/evidence/screenshots/` are pre-redacted (`*-redacted.png`) |

## Not imported (deliberately)

- `polsia-audit-complete.zip`, `polsia-export-checked.zip`, `polsia-export-checked-source.zip`
  (Downloads) — additional variants not named in the import instruction; owner review needed
  before importing. `polsia-export-checked*` appear to be exported application code, which may
  carry licensing/provenance questions.

## Evidence classes (per the audit review)

The package mixes four evidence classes that must not be conflated:

1. Direct observations from the authenticated Polsia control panel — usable for parity claims.
2. Statements from Polsia's in-app FAQ and public legal/product pages — usable for parity claims.
3. Features generated for the disposable test company ("Vigilix") — NOT Polsia platform
   functionality; do not cite as such.
4. Recommended architecture/safety controls — our design proposals, not evidence about Polsia.

See `polsia-audit-review.md` for per-area confidence levels and corrected build direction.
