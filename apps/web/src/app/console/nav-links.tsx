'use client';

/*
 * ACBP-FE-004 — the BUILT navigation links.
 *
 * WHY THIS IS A CLIENT COMPONENT, when the rest of the shell is not. `aria-current="page"` has to name exactly
 * one link, and a server layout cannot know the current pathname — Next gives it to `usePathname()` only on the
 * client. While the console had a single built destination the layout could hard-code the attribute and be
 * right by accident; adding a second one made that hard-coded value a lie on whichever page you were not on,
 * announced to a screen reader as two current pages at once.
 *
 * The alternative was dropping `aria-current` altogether, which trades a wrong signal for no signal. This keeps
 * the signal and makes it true. It renders plain links, so it works before hydration; only the "you are here"
 * marking depends on the client.
 */

import { usePathname } from 'next/navigation';

export interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}

export function NavLinks({ links }: { links: readonly NavLink[] }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <ul className="cs-nav">
      {links.map((n) => {
        // Exact match only. A `startsWith` test would mark Overview (`/console`) as current on every console
        // page, which is the same false claim in a subtler form.
        const current = pathname === n.href;
        return (
          <li key={n.href}>
            <a href={n.href} {...(current ? { 'aria-current': 'page' as const } : {})}>
              <span className="cs-ico" aria-hidden="true">
                {n.icon}
              </span>
              {n.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
