'use client';

/*
 * ACBP-FE-001 — an animated number counter for the stat cards.
 *
 * THE ONLY CLIENT COMPONENT IN THIS SLICE. Everything else renders on the server; this needs one because the
 * count-up is a timed animation over real DOM state, which CSS alone cannot express for arbitrary numbers.
 *
 * REDUCED MOTION IS HONOURED IN JS, NOT ONLY IN CSS. The CSS block zeroes the duration TOKENS, which stops the
 * card entrance — but this animation is driven by requestAnimationFrame, and a token cannot reach it. So the
 * media query is read here too, and when a reader has asked for stillness this component does nothing at all:
 * the correct number is already rendered, so stillness costs no extra step and there is no state to restore.
 * A counter that ticked anyway would be exactly the kind of motion the preference exists to stop.
 */

import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 900;
/** Ease-out cubic: fast at first, settling gently — matches the card entrance rather than fighting it. */
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

export function Counter({ value, display }: { value: number; display?: string }): React.JSX.Element {
  // THE INITIAL STATE IS THE FINAL VALUE, NOT ZERO — so the server-rendered HTML carries the real figure.
  // Starting at 0 meant the markup said "0 credits remaining" until hydration ran, and said it permanently to
  // anyone without JavaScript. A number that is wrong whenever the animation cannot run is not a decoration,
  // it is a false reading; the count-up is an effect layered on top of a correct value, never the source of it.
  const [shown, setShown] = useState(value);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    // A non-numeric stat (the stop status reads "Clear") has nothing to count toward; it renders verbatim.
    if (display !== undefined) return;

    // Reduced motion is honoured HERE and not only in CSS: this animation is driven by requestAnimationFrame,
    // which a zeroed duration token cannot reach. Leaving `shown` alone keeps the already-correct value.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Motion is allowed: drop back to zero and count up to the value the markup already showed.
    setShown(0);
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      setShown(Math.round(easeOut(t) * value));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [value, display]);

  if (display !== undefined) return <>{display}</>;
  return <>{shown.toLocaleString('en-US')}</>;
}
