# API and event contracts

These are recommended contracts for a comparable platform, not claims about Polsia’s private API.

## REST surface

| Method | Path | Purpose | Safety |
|---|---|---|---|
| POST | `/v1/companies` | Create company brief and onboarding workflow | reversible |
| GET | `/v1/companies/{companyId}` | Company summary and lifecycle | read |
| GET | `/v1/companies/{companyId}/activity` | Cursor-paginated activity | read |
| POST | `/v1/companies/{companyId}/tasks` | Create a task/recurrence | reversible |
| POST | `/v1/tasks/{taskId}/runs` | Request run-now; returns preflight | approval/credit |
| POST | `/v1/runs/{runId}/cancel` | Cancel a pending run | reversible |
| GET | `/v1/companies/{companyId}/connections` | Connection health/scopes | read |
| POST | `/v1/companies/{companyId}/connections/{provider}/authorize` | Begin OAuth | consent |
| DELETE | `/v1/connections/{connectionId}` | Disconnect and revoke | destructive/reversible window |
| GET | `/v1/companies/{companyId}/approvals` | Approval queue | read |
| POST | `/v1/approvals/{approvalId}/decisions` | Approve/reject with content hash | consequential |
| GET | `/v1/companies/{companyId}/deployments` | Versions and health | read |
| POST | `/v1/companies/{companyId}/deployments` | Deploy a reviewed artifact | approval |
| POST | `/v1/deployments/{deploymentId}/rollback` | Roll back to prior version | approval |
| GET | `/v1/companies/{companyId}/credits/ledger` | Usage and balance | read |
| GET | `/v1/companies/{companyId}/documents` | Company memory/documents | read |

## Event envelope

```json
{
  "id": "evt_…",
  "type": "task.run.requested",
  "occurred_at": "2026-07-18T00:00:00Z",
  "tenant_id": "ten_…",
  "company_id": "co_…",
  "actor": {"kind": "user|agent|system", "id": "…"},
  "correlation_id": "wf_…",
  "idempotency_key": "…",
  "data": {},
  "provenance": {"source": "ui|provider|agent", "confidence": "observed|documented|inferred"}
}
```

## Canonical events

`company.created`, `onboarding.step.started`, `onboarding.step.completed`, `onboarding.step.failed`, `cycle.started`, `task.created`, `task.state.changed`, `task.run.requested`, `task.run.completed`, `task.run.failed`, `connection.authorized`, `connection.health.changed`, `provider.event.received`, `narrative.generated`, `approval.requested`, `approval.decided`, `external.write.confirmed`, `deployment.started`, `deployment.healthy`, `deployment.rolled_back`, `credit.granted`, `credit.spent`, `credit.refunded`, `credit.expired`, `member.invited`, and `audit.recorded`.

## Webhook rules

Verify provider signatures, persist raw payload only in encrypted quarantine, normalize to the event schema, deduplicate by provider event ID, and publish after transaction commit. Never execute an external write directly from an unverified webhook.
