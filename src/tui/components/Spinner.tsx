/**
 * The activity indicator.
 *
 * A static "thinking…" is invisible: the user reported not noticing it at all,
 * and a phantom that pauses for twenty seconds with an unchanging label is
 * indistinguishable from one that has hung. So this ticks — the frames move,
 * and the elapsed seconds count up beside them. Motion is the signal; the
 * number is the reassurance.
 *
 * The interval is owned here and cleared on unmount, so an interrupted turn
 * cannot leave a timer re-rendering the app forever.
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";

/** Braille dots: one cell wide in every font we care about, unlike emoji. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const SPINNER_INTERVAL_MS = 80;

export function useSpinnerFrame(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setTick((n) => n + 1),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}

/** Whole seconds since `since`, re-rendered once a second while active. */
export function useElapsedSeconds(since: number | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [since]);
  if (since === undefined) return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
}

export function Spinner(props: { color?: string }): React.ReactElement {
  const frame = useSpinnerFrame(true);
  return <Text color={props.color}>{frame}</Text>;
}
