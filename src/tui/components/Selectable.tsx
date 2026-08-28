/**
 * A clickable, keyboard-selectable row.
 *
 * Hit-testing is done by having each row register its OWN measured rect with
 * the mouse dispatcher — `measureElement` on its ref — never by computing
 * coordinates from `stdout.columns`. That keeps the same discipline as the
 * borders: a component may not know where it is on screen; it may only ask.
 *
 * The dispatcher, not the row, decides who gets a click: it routes to the
 * TOPMOST registered rect containing the point, so a modal drawn over a list
 * takes the click rather than the row beneath it. One subscription in `App`
 * drives that, instead of every row racing on its own listener.
 *
 * Mouse is ALWAYS optional: every row reachable by clicking is reachable with
 * ↑↓ and ↵, and the app is fully usable with mouse reporting off.
 */

import React, { useEffect, useRef } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";

import { mouse } from "../mouse.ts";
import { glyph, theme } from "../theme.ts";

let nextId = 0;

interface YogaNode {
  getComputedLeft(): number;
  getComputedTop(): number;
}

/**
 * Absolute screen position of a node.
 *
 * Yoga reports `getComputedLeft`/`getComputedTop` RELATIVE TO THE PARENT, not
 * relative to the screen — using them directly puts every nested row at the
 * offset of its own container and sends clicks to nothing. So the offsets are
 * summed up the parent chain, which is the only correct reading.
 *
 * Returns undefined when no Yoga node is available, so a caller can decline to
 * register rather than register a wrong rect.
 */
export function absolutePosition(
  node: DOMElement,
): { left: number; top: number } | undefined {
  let left = 0;
  let top = 0;
  let current: (DOMElement & { yogaNode?: YogaNode }) | undefined =
    node as DOMElement & { yogaNode?: YogaNode };
  let sawYoga = false;
  while (current) {
    const yoga = current.yogaNode;
    if (yoga) {
      sawYoga = true;
      left += yoga.getComputedLeft();
      top += yoga.getComputedTop();
    }
    current = current.parentNode as
      | (DOMElement & { yogaNode?: YogaNode })
      | undefined;
  }
  return sawYoga ? { left, top } : undefined;
}

export function Selectable(props: {
  selected?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<DOMElement>(null);
  const idRef = useRef<string>(`row-${nextId++}`);

  // Re-register on every render: a row's position moves whenever content above
  // it changes, and a stale rect sends clicks to the wrong row.
  useEffect(() => {
    const id = idRef.current;
    const node = ref.current;
    if (!node || !mouse.enabled) return;
    const { width, height } = measureElement(node);
    const position = absolutePosition(node);
    // No Yoga node anywhere up the chain means no honest rect. We simply do
    // not register: the row loses its mouse target and keeps its keyboard one,
    // which is the degradation this whole feature promises.
    if (!position) return;
    mouse.register(
      {
        id,
        // Terminal coordinates are 1-based; Yoga's are 0-based. This +1 is the
        // only coordinate arithmetic in the app, and it lives here alone.
        left: position.left + 1,
        top: position.top + 1,
        width,
        height,
      },
      props.onPress,
    );
    return () => mouse.unregister(id);
  });

  return (
    <Box ref={ref}>
      <Box marginRight={1}>
        <Text color={theme.accent}>{props.selected ? glyph.selected : " "}</Text>
      </Box>
      <Box flexGrow={1}>{props.children}</Box>
    </Box>
  );
}
