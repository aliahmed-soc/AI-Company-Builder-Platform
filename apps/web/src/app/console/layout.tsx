/*
 * ACBP-FE-002 — the console application shell: sidebar navigation + top bar.
 *
 * Scoped to `/console`. The ACBP-P1-001 authentication header is NOT inherited here: it moved to the `(site)`
 * route group, so the console shell is no longer stacked underneath an auth placeholder bar. That is a layout
 * relocation only — `ClerkProvider` still wraps this subtree from the root layout, and the boundary itself
 * (`src/proxy.ts`) is untouched. Nothing here reads a session, a company, or a role.
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

// The viewport meta tag this layout used to declare now lives on the ROOT layout, where it covers `/`,
// `/sign-in` and `/sign-up` as well — the gap was app-wide, not console-only. Nothing is declared here,
// because a nested layout inheriting it is the whole point.

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
