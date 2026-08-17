/*
 * ACBP-FE-002 — the console application shell: sidebar navigation + top bar.
 *
 * Scoped to `/console` rather than replacing the root layout, so the existing authentication boundary
 * (ACBP-P1-001) is untouched by a visual slice. Nothing here reads a session, a company, or a role.
 *
 * NAVIGATION IS DELIBERATELY NOT LINKED to routes that do not exist yet. Every destination except the overview
 * is rendered as a non-navigating item with `aria-disabled` — a sidebar full of links that 404 looks finished
 * and is worse than one that admits what is built.
 *
 * THE EMERGENCY STOP CONTROL IS A VISUAL PLACEHOLDER (see the button's own comment). ACBP-FE-017 is Blocked-API.
 */
import type { ReactNode } from 'react';
import './console.css';
import { MOCK_COMPANY } from './mock-data';

export const metadata = {
  title: 'Console — AI Company Builder',
  description: 'Company overview (ACBP-FE Slice 1; mock data).',
};

/*
 * WITHOUT THIS, THE RESPONSIVE RULES NEVER RUN ON A PHONE. The app ships no viewport meta tag anywhere
 * (verified: no occurrence of `viewport` or `device-width` under apps/web/src before this line), so a mobile
 * browser lays the page out at a fallback desktop width and scales it down — the narrow-width media queries
 * in console.css would simply never match on the device they were written for. Measured, not assumed: under
 * Chrome mobile emulation at 420px, `window.innerWidth` reported 1395 until this export existed.
 *
 * Declared on the CONSOLE layout, not the root one: the gap is app-wide, but the root layout is the P1-001
 * authentication boundary and is out of scope for this visual slice. The app-wide gap is reported in the PR.
 */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

/** Built, and therefore linked. Everything else is listed but inert. */
const NAV_BUILT = [{ href: '/console', label: 'Overview', icon: '▤' }];

const NAV_PLANNED: ReadonlyArray<{ group: string; items: ReadonlyArray<{ label: string; icon: string }> }> = [
  {
    group: 'Discovery',
    items: [
      { label: 'Interview', icon: '◇' },
      { label: 'Understanding', icon: '◈' },
      { label: 'Memory', icon: '▢' },
    ],
  },
  {
    group: 'Plan',
    items: [
      { label: 'Strategy', icon: '◐' },
      { label: 'Roadmap', icon: '◑' },
      { label: 'Tasks', icon: '☰' },
    ],
  },
  {
    group: 'Operate',
    items: [
      { label: 'Decision Room', icon: '⚖' },
      { label: 'Approvals', icon: '⚑' },
      { label: 'Activity', icon: '≡' },
      { label: 'Usage', icon: '◧' },
    ],
  },
];

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="cs-root">
      <a className="cs-skip" href="#cs-main">
        Skip to content
      </a>
      <div className="cs-shell">
        <aside className="cs-side">
          <div className="cs-brand">
            <div className="cs-brand-mark" aria-hidden="true">
              AC
            </div>
            <div>
              <div className="cs-brand-name">ACBP</div>
              <div className="cs-brand-sub">Company Builder</div>
            </div>
          </div>

          <nav aria-label="Console">
            <div className="cs-navgroup-label">Overview</div>
            <ul className="cs-nav">
              {NAV_BUILT.map((n) => (
                <li key={n.href}>
                  <a href={n.href} aria-current="page">
                    <span className="cs-ico" aria-hidden="true">
                      {n.icon}
                    </span>
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>

            {NAV_PLANNED.map((g) => (
              <div key={g.group} className="cs-navgroup">
                <div className="cs-navgroup-label">{g.group}</div>
                <ul className="cs-nav">
                  {g.items.map((n) => (
                    <li key={n.label}>
                      {/* Not a link: the destination does not exist. `aria-disabled` states that to a screen
                          reader; the dimmed style states it to everyone else. */}
                      <a aria-disabled="true" style={{ opacity: 0.45, cursor: 'not-allowed' }}>
                        <span className="cs-ico" aria-hidden="true">
                          {n.icon}
                        </span>
                        {n.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div className="cs-main">
          <header className="cs-top">
            <div className="cs-company">
              <span className="cs-avatar" aria-hidden="true">
                {MOCK_COMPANY.initials}
              </span>
              <span>{MOCK_COMPANY.name}</span>
              <span className="cs-badge cs-badge--muted">{MOCK_COMPANY.plan}</span>
            </div>
            <span className="cs-spacer" />
            {/*
              EMERGENCY STOP — VISUAL PLACEHOLDER ONLY (ACBP-FE-017 is Blocked-API).
              `disabled` rather than a no-op handler: a button that looks live and silently does nothing is the
              failure mode this repository keeps finding (a control that is a label, not a control). This one
              cannot be pressed, and its title says why.
            */}
            <button
              type="button"
              className="cs-btn cs-btn--danger"
              disabled
              title="Visual placeholder — not wired in this slice (ACBP-FE-017)"
            >
              ⏻ Emergency stop
            </button>
            <span className="cs-avatar" aria-hidden="true" style={{ width: 30, height: 30 }}>
              AA
            </span>
          </header>

          <main id="cs-main" className="cs-content">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
