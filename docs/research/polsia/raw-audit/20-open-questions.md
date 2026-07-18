# Open questions

## Product behavior

1. What exact inputs, outputs, and approval boundaries exist for each agent/tool?
2. What does “one night shift” include, and how is a cycle budgeted or stopped?
3. Which task types are recurring, and how are schedules, time zones, and missed runs handled?
4. How are generated claims linked to source events, documents, or metrics?
5. What is the expected behavior when a company is paused during an in-flight run?

## Integrations and infrastructure

6. Which providers are live today versus roadmap-only, and what OAuth scopes are requested?
7. Are email, database, sandbox, and hosting resources one-per-company or shared with isolation?
8. What is the deployment topology, build isolation boundary, rollback retention, and backup/restore SLA?
9. Which public-site URLs are stable, and how are custom domains, DNS, TLS, and redirects handled?
10. How are webhooks verified, replayed, deduplicated, and backfilled after provider downtime?

## Billing and money movement

11. Why does the observed New Company UI show `+$20/mo each` while FAQ wording says `$25/mo each`?
12. How are the platform subscription, task credits, AI allowance, ad spend, customer funds, fees, taxes, refunds, and chargebacks separated?
13. When are credits granted, expirable, refunded, or reset, and what happens on cancellation/proration?
14. What disclosures and regulated-money responsibilities apply to the customer-payment balance?

## Safety, privacy, and legal

15. What are the exact terms, privacy policy, acceptable-use rules, retention periods, deletion exceptions, and subprocessors?
16. What data may agents store in company memory, and how can a user export or erase it?
17. What human review is mandatory for ads, outreach, customer support, legal/medical content, and account changes?
18. How are prompt injection, malicious attachments, unsafe code, and sensitive personal data detected?
19. What incident notification, audit export, and support escalation commitments exist?

## Research follow-up

20. Can a disposable test company be used to run one free/sandbox cycle and capture the full trace?
21. Can first-party support confirm the pricing contradiction and current integration list?
22. Can a non-sensitive sample task expose the actual failure reason and retry semantics?
23. Which claims in generated market research are sourced, and which are synthetic recommendations?
24. What compatibility target is intended: UI parity, workflow parity, or business-model parity?
