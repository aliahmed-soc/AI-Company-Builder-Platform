/*
 * ⚠️ MOCK DATA — INVENTED, NOT READ FROM ANYTHING. ⚠️
 *
 * ACBP-FE Slice 1 renders the console shell and the company overview against these constants. Nothing here is
 * fetched, nothing is persisted, and no value corresponds to a real company, balance, task or approval.
 *
 * WHY MOCK RATHER THAN WIRED, stated so the next reader does not treat this file as a stub to be "finished":
 * the slice is scoped to the LOOK. Wiring the overview means the approvals inbox (FE-016), emergency stop
 * (FE-017) and usage display (FE-018).
 *
 * ⚠️ CORRECTED 2026-08-19 (ACBP-FE-018). That sentence used to end "— all three are `Blocked-API` in
 * FRONTEND-BACKLOG.csv", which is no longer true of two of them: FE-016 is Done and FE-018 shipped a real
 * `/console/usage` screen in this change. Only FE-017 is still Blocked-API.
 *
 * WHAT HAS NOT CHANGED IS THE PART THAT MATTERS HERE: the CREDIT figure below still has no backend to read
 * (CDR-092 §10 — nothing debits a company's balance yet), and building FE-018 did NOT supply one.
 * `USAGE_ROLLUP_LANES` carries eventCount, inputTokens, outputTokens and estimatedCostMicros — there is no
 * credits lane, no allowance and no balance anywhere in the usage contract, because the commercial formula is an
 * open decision. So `MOCK_STATS`' "credits remaining of a monthly allowance" cannot be wired from the usage read
 * and must not be: the real screen at `/console/usage` deliberately shows provider-cost micro-units and says in
 * as many words that no billing, plan or balance exists.
 *
 * Every export is prefixed `MOCK_` so a call site cannot use one without the reader seeing what it is, and the
 * rendered page carries a visible banner saying the same thing to whoever is looking at the screen rather than
 * the source.
 */

export interface MockStat {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display?: string;
  readonly foot: string;
  readonly icon: string;
  readonly tint: string;
  readonly iconBg: string;
  readonly iconFg: string;
}

/** The four overview figures. `value` is numeric so the counter can animate toward it. */
export const MOCK_STATS: readonly MockStat[] = [
  {
    id: 'credits',
    label: 'Credits remaining',
    value: 48250,
    foot: 'of 60,000 this month',
    icon: '◈',
    tint: 'rgba(76, 141, 255, 0.16)',
    iconBg: 'var(--c-primary-soft)',
    iconFg: 'var(--c-primary)',
  },
  {
    id: 'tasks',
    label: 'Active tasks',
    value: 12,
    foot: '3 running, 9 queued',
    icon: '◆',
    tint: 'rgba(36, 209, 155, 0.16)',
    iconBg: 'var(--c-success-soft)',
    iconFg: 'var(--c-success)',
  },
  {
    id: 'approvals',
    label: 'Awaiting approval',
    value: 4,
    foot: 'oldest waiting 2 days',
    icon: '⚑',
    tint: 'rgba(255, 193, 77, 0.16)',
    iconBg: 'var(--c-warning-soft)',
    iconFg: 'var(--c-warning)',
  },
  {
    id: 'stop',
    label: 'Emergency stop',
    value: 0,
    display: 'Clear',
    foot: 'no stop active',
    icon: '⏻',
    tint: 'rgba(149, 117, 255, 0.16)',
    iconBg: 'var(--c-secondary-soft)',
    iconFg: 'var(--c-secondary)',
  },
];

export interface MockApproval {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly kind: 'primary' | 'warning' | 'danger' | 'muted';
  readonly kindLabel: string;
}

export const MOCK_APPROVALS: readonly MockApproval[] = [
  { id: 'a1', title: 'Publish pricing page copy', meta: 'Marketing worker · requested 2 days ago', kind: 'warning', kindLabel: 'External' },
  { id: 'a2', title: 'Send outreach to 40 contacts', meta: 'Sales worker · requested 9 hours ago', kind: 'danger', kindLabel: 'Irreversible' },
  { id: 'a3', title: 'Register the .com domain', meta: 'Ops worker · requested 5 hours ago', kind: 'danger', kindLabel: 'Spend' },
  { id: 'a4', title: 'Approve Q3 roadmap revision', meta: 'Planning worker · requested 1 hour ago', kind: 'primary', kindLabel: 'Plan' },
];

export interface MockActivity {
  readonly id: string;
  readonly text: string;
  readonly time: string;
  readonly tone: 'primary' | 'success' | 'warning' | 'danger' | 'muted';
}

export const MOCK_ACTIVITY: readonly MockActivity[] = [
  { id: 'e1', text: 'Roadmap v4 generated — 3 goals, 11 milestones', time: '14:20', tone: 'primary' },
  { id: 'e2', text: 'Task “Draft launch email” completed', time: '13:58', tone: 'success' },
  { id: 'e3', text: 'Approval requested: send outreach to 40 contacts', time: '13:31', tone: 'warning' },
  { id: 'e4', text: 'Strategy option B selected as the first phase', time: '11:04', tone: 'primary' },
  { id: 'e5', text: 'Task “Competitor scan” failed — provider timeout', time: '09:47', tone: 'danger' },
  { id: 'e6', text: 'Understanding confirmed by owner', time: '09:12', tone: 'success' },
];

export const MOCK_COMPANY = { name: 'Northwind Coffee', initials: 'NC', plan: 'Growth' } as const;
