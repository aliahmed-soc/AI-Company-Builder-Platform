# Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner/status |
|---|---|---:|---:|---|---|
| R-01 | Agent sends an unapproved external message | M | H | Default-deny policy, approval-bound content hash, provider receipt | Product/Security — open |
| R-02 | Duplicate provider write after retry | M | H | Outbox, idempotency keys, receipt reconciliation | Platform — open |
| R-03 | Cross-company data exposure | L/M | H | Tenant context middleware, row-level policies, adversarial tests | Security — open |
| R-04 | Secret leakage in logs/export | M | H | KMS references, redaction, secret scanning, export denylist | Security — open |
| R-05 | Hallucinated metric or task completion | M | H | Evidence/provenance fields, receipt-required success, reviewer agent | AI/UX — open |
| R-06 | Failed workflow leaves paid resources orphaned | M | M/H | Saga compensation, reconciler, operator dashboard | Platform — open |
| R-07 | Credit/billing race or mismatch | M | H | Ledger transactions, billing reconciliation, deterministic locks | Billing — open |
| R-08 | OAuth token expiry breaks autonomous cycle | H | M | Health checks, reauth prompts, read/write scope separation | Integrations — open |
| R-09 | Ads or customer payments create regulatory exposure | M | H | Legal review, caps, consent, disclosures, human approval | Legal — open |
| R-10 | Generated code introduces vulnerability | M | H | Isolated builds, SAST/dependency scan, preview, rollback | Engineering — open |
| R-11 | Prompt injection from email/social content | H | H | Treat external content as untrusted, tool firewall, content isolation | AI/Security — open |
| R-12 | Ambiguous deletion/deactivation harms user | L/M | H | Two-step confirmation, cooling-off window, export, staged purge | Product — open |
| R-13 | Provider API or hosting outage | M | M | Queue buffering, retries, status messaging, alternate provider plan | SRE — open |
| R-14 | Privacy/retention policy is unclear | M | H | Data map, consent ledger, retention controls, DPA/legal review | Legal/Privacy — open |
| R-15 | Marketing claims are mistaken for implementation facts | H | M | Evidence labels and claim register; source links in docs | Research — mitigated |
