# ADR-008 — Task and Workflow Execution

1. **Title:** Postgres-backed durable jobs and checkpointed workflows
2. **Status:** Accepted with amendment (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** Tasks must be durable (TASK-001), resumable (NFR-005), idempotent (TASK-009/NFR-006), with bounded retries (NFR-007). Enqueueing must be transactional with task state, credit reservation, and audit writes (BILL-002 race rule, AT-025 pattern).
5. **Decision proposal:** Durable job and workflow-checkpoint tables in the primary PostgreSQL database, processed by the worker via a mature Postgres job-runner library (pg-boss/graphile-worker class). Transactional outbox for events. Job rows carry mandatory tenant context (invariant 3). Checkpoints per workflow step enable kill-and-resume. Dead-letter surface = Decision Room blocked queue.
6. **Requirement IDs:** TASK-001, TASK-004, TASK-009, NFR-005, NFR-006, NFR-007, BILL-002.
7. **Alternatives:** Redis+BullMQ-class queue (second stateful system; enqueue not transactional with Postgres state without outbox gymnastics); Temporal-class durable engine (strong but heavy for MVP scale — designated scale-up path); external automation platforms (control/audit requirements fail).
8. **Benefits:** One datastore; atomic enqueue+state+ledger+audit; simplest ops; honest failure surfaces.
9. **Costs:** Postgres carries queue load; polling/notify tuning needed.
10. **Risks:** Job-table bloat (mitigate: archival jobs); throughput ceiling (documented trigger below).
11. **Security implications:** Job payloads carry references not secrets; tenant context mandatory.
12. **Operational implications:** Queue-health metrics from SQL; one backup story covers jobs.
13. **Reversal cost:** Medium — job semantics (idempotency, checkpoints) are library-independent design.
14. **Scale trigger:** >~50 sustained jobs/sec, or multi-day cross-service sagas → Temporal-class engine (AOQ-17).
15. **Open questions:** AOQ-08 (owner confirmation of this default).
16. **Owner approval:**

```text
Owner decision:
[ ] Accept   [x] Accept with changes   [ ] Reject   [ ] Defer
Notes: AMENDMENT — binding triggers: >50 jobs/sec sustained, OR p95 pickup latency >5s over 24h, OR multi-day sagas → evaluate Temporal-class (AOQ-17); queue-driven DB connection pressure → evaluate Redis-class ONLY on that evidence (no Redis dependency without demonstrated need). Runs on Render PostgreSQL, private networking; NO Render Workflows dependency for MVP; job tables remain standard SQL (exit path).
Date: 2026-07-18
```
