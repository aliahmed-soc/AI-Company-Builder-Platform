# Task and agent system

## Task lifecycle observed

The manager exposes these visible buckets: `To Do`, `↻ Recurring`, `In Progress`, `Completed`, `Rejected`, and `Failed`. The To Do list contained research and feature tasks, including scheduled `Tonight` tasks. The other buckets were empty except Failed, which contained `Build Twitter-to-Email narrative report MVP`.

Task detail showed a `Todo` or `Failed` status, `Type`, `Created`, a structured description, `Delete`, `Repeat`, and (for Todo) `Run now`. The failed task showed no error text or retry explanation; `Repeat` is the visible recovery control. Evidence type: UI, 99%.

## Autonomous planning observation

Clicking `+ New tasks` caused the dashboard to show `Planning…`, then an `Agent working` status and three new task cards in the activity feed: Slack delivery, mention/sentiment detection, and a reusable account connection hub. No per-task approval dialog or credit confirmation appeared, and no task was run. This is a side-effecting observation: planning added tasks, but did not execute them.

## Visible roles and responsibilities

The UI does not name independent agents. It does expose role-like work labels and activity stages:

- Strategy/planning: “Reviewing your project…”, “Drafting your next 3 tasks…”, mission and roadmap.
- Research: market research and competitor mapping tasks.
- Engineering/product: codebase setup, file reads/edits, npm, commits, publishing, OAuth and event-detection tasks.
- Infrastructure: database, hosting, sandbox, secrets, versions, domains.
- Marketing/social: Twitter, Auto-tweet, Tweet, ads, public landing page.
- Communications: company email, welcome email, planned Slack delivery.
- Operations: task queue, credits, pause, company settings, dashboard activity.

Evidence type: UI labels and activity stream, 95–99%. These labels are capabilities, not proof of separate backend services.

## FAQ-backed cycle model

The current FAQ says a cycle reviews company state, checks email/social/analytics, generates prioritized tasks, executes coding/content/outreach, updates dashboards, and plans the next cycle. It says cycles run daily in the early morning. Manual tasks use one task credit; the FAQ also says a user can ask chat to run a specific task. Evidence type: first-party FAQ, 85%.

## Controls not exercised

God Mode, Run now, recurring-task creation, Repeat, pause/resume, task rejection, task cancellation, approvals, and automatic retry were not activated. The audit therefore cannot establish their full runtime behavior.
