/** Arrow carousels of the look studio (pure, so it is testable without a DOM). */

/** Next choice in a carousel, wrapping around and skipping `skip`. */
export function cycleOption(
  options: readonly { id: string }[],
  current: string,
  dir: -1 | 1,
  skip: ReadonlySet<string> = new Set(),
): string {
  const n = options.length;
  let i = Math.max(
    0,
    options.findIndex((o) => o.id === current),
  );
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    const id = options[i]!.id;
    if (!skip.has(id)) return id;
  }
  return current;
}
