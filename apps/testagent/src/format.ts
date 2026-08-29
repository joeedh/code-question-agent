/** Formats a token count compactly, e.g. `100000` -> `"100k"`, `12345` -> `"12.3k"`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
}
