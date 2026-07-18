# Approval and authorization matrix

Only directly observed behavior is marked; a blank/unknown cell is intentional.

| Action | No approval observed | Prior category approval | Per-action approval | Unknown / limitation |
|---|---:|---:|---:|---|
| Internal research | ✓ |  |  | Onboarding research was shown in activity; no approval prompt was visible. (UI, 95%) |
| Code generation | ✓ |  |  | Onboarding showed code reads/edits/npm/commit; no prompt observed. (UI, 95%) |
| Production deployment | ✓ |  |  | Onboarding said publishing completed; Redeploy is a separate control; exact approval semantics unknown. (UI, 70%) |
| Sending one email | ✓ |  |  | Welcome email appeared as sent during onboarding; no per-email prompt observed. (UI, 95%) |
| Email campaign |  |  |  | No campaign flow tested. |
| Social post |  |  |  | Tweet/Auto-tweet controls visible; no publish confirmation tested. |
| Advertising spend |  |  |  | Ads control is subscription-gated; FAQ says budget limits exist, but no spend flow tested. (FAQ, 85%) |
| Refund |  |  |  | Credits ledger showed a refund movement; no refund action tested. |
| Subscription change |  |  |  | Subscribe and Stripe portal controls visible; no purchase or change submitted. |
| Data deletion |  |  |  | Delete Company and Deactivate Account are visible; neither was activated. |

## Direct approval evidence

- FAQ says Polsia cannot take irreversible actions without approval. This is a product claim, not a tested approval screen. (FAQ, 85%)
- Company Settings labels Delete Company as a Danger Zone action and “This cannot be undone.” (UI, 99%)
- Team invites explicitly state the invite grants access only to the current company, not other companies. (UI, 99%)
- Ads FAQ says users set budget limits, but the audit did not create or launch an ad. (FAQ, 85%)

## Requirements implication

A comparable product should make approval scope explicit: once, category-wide, scheduled, budget-capped, revocable, and previewable. Polsia’s visible UI does not expose enough detail to classify those dimensions reliably.
