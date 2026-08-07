/**
 * Pastel-aware Ink shim.
 *
 * Ink resolves a bare colour name (`color="red"`) against the terminal's own
 * 16-colour palette. Rather than rewrite the ~200 hardcoded colour attributes
 * spread across this package, `Text` and `Box` are wrapped so every `color` /
 * `backgroundColor` / `borderColor` they receive is routed through `softColor`
 * (see `theme.ts`). One import swap per component — `from "ink"` becomes
 * `from "./ink.js"` — remaps the whole UI, and it keeps catching values a
 * search-and-replace never could: syntax-highlight tokens, per-agent accents
 * from `agentColor()`, and every `cond ? "green" : "gray"` ternary.
 *
 * Everything else Ink exports is re-exported untouched, so the swap is only
 * ever that one line.
 */

import { type DOMElement, Box as InkBox, Text as InkText } from "ink";
import type { ComponentProps, ForwardRefExoticComponent, RefAttributes } from "react";
import { forwardRef } from "react";
import { softColor } from "./theme.js";

// The colour props are widened with `| undefined` on purpose: the shim strips
// them and re-attaches only what resolves, so a call site writing
// `color={selected ? "cyan" : undefined}` type-checks here even though Ink's
// own props reject it under `exactOptionalPropertyTypes`.
type TextOwnProps = Omit<ComponentProps<typeof InkText>, "color" | "backgroundColor"> & {
  color?: string | undefined;
  backgroundColor?: string | undefined;
};
type BoxOwnProps = Omit<
  ComponentProps<typeof InkBox>,
  "ref" | "borderColor" | "backgroundColor"
> & {
  borderColor?: string | undefined;
  backgroundColor?: string | undefined;
};

export {
  Static,
  measureElement,
  useApp,
  useFocus,
  useFocusManager,
  useInput,
  useStdin,
  useStdout,
  render,
} from "ink";
export type { BoxProps, DOMElement, Key, TextProps } from "ink";

/**
 * `exactOptionalPropertyTypes` forbids passing `color={undefined}`, so a prop
 * is attached only when it resolves to a value.
 */
function colorProps(color?: string, backgroundColor?: string) {
  const c = softColor(color);
  const bg = softColor(backgroundColor);
  return { ...(c ? { color: c } : {}), ...(bg ? { backgroundColor: bg } : {}) };
}

/** Ink's `Text` with `color`/`backgroundColor` remapped to the pastel palette. */
export function Text({ color, backgroundColor, ...rest }: TextOwnProps): React.ReactElement {
  return <InkText {...rest} {...colorProps(color, backgroundColor)} />;
}

/**
 * Ink's `Box` with `borderColor`/`backgroundColor` remapped. The ref is
 * forwarded because `measureElement` (the fullscreen transcript's height
 * measurement) needs the underlying DOM element.
 */
export const Box: ForwardRefExoticComponent<BoxOwnProps & RefAttributes<DOMElement>> = forwardRef<
  DOMElement,
  BoxOwnProps
>(function Box({ borderColor, backgroundColor, ...rest }, ref) {
  const bc = softColor(borderColor);
  const bg = softColor(backgroundColor);
  return (
    <InkBox
      ref={ref}
      {...rest}
      {...(bc ? { borderColor: bc } : {})}
      {...(bg ? { backgroundColor: bg } : {})}
    />
  );
});
