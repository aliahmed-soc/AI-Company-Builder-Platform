# Competitive gaps and opportunities

This is a product-design comparison against the observed/documented Polsia surface, not a claim about competitors’ private systems.

| Area | Observed/documented baseline | Comparable-product opportunity |
|---|---|---|
| Trust | Autonomous language, limited visible approval evidence | Make policy, approval preview, evidence, and receipts first-class in every action. |
| Failure recovery | Failed tab observed but no error detail in sampled task | Add error taxonomy, retry guidance, compensation state, and support bundle. |
| Integrations | Roadmap describes expanding connectors; OAuth is partial | Ship connector health, scope minimization, reauth, sync cursors, and test events. |
| Task economics | Credits and manual-run cost are visible in FAQ/ledger | Show cost preview, budget reservations, forecast, and per-agent spend. |
| Deployment | Versions/redeploy UI visible; no versions in sample | Add immutable artifacts, previews, diff, canary, health checks, and one-click rollback. |
| Data portability | Download Code documented; self-hosting “coming soon” | Export code, documents, events, configuration, and reproducible deployment manifest. |
| Collaboration | Company-scoped invite observed | Roles, approval delegation, review queues, comments, and audit exports. |
| Analytics | Visitors/revenue cards observed | Source lineage, freshness, event definitions, anomaly explanation, and goals. |
| Billing | Stripe portal and fee claims documented | Separate platform subscription, task credits, ad spend, customer funds, fees, taxes. |
| Safety boundaries | FAQ lists prohibited/approval-sensitive actions | Enforce machine-readable policy with simulation and operator override audit. |

## Differentiating thesis

Build “auditable autonomy”: the system can move quickly, but every meaningful action is inspectable, reversible where possible, and honest about uncertainty. This directly addresses the biggest parity risk revealed by the audit: visible capability claims are broader than the tested execution paths.
