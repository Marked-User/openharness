/** Addresses the page loads for itself that the Hub's sandbox serves: none, apart from these. */
const inline = /^(?:data:|blob:|#|about:|javascript:)/i;

const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(value => value !== undefined)?.trim();

/**
 * What a page's own scripts load: modules (`import … from "…"`, `import "…"`, `export … from "…"`,
 * `import("…")`) and `fetch("…")`. A module from a CDN is the usual way a one-file page still needs
 * the network (three.js from jsdelivr), and the sandbox blocks it.
 */
const scriptBody = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const scriptLoads = [
  /\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bfetch\s*\(\s*["'`]([^"'`\n]+)["'`]/g,
];

/**
 * Files and addresses an output page loads that the published preview cannot reach: the sandbox
 * serves no other file and blocks the network, so each one is missing for readers.
 */
export function outsideResources(html: string): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => { if (value && !inline.test(value)) found.add(value); };
  for (const [tag] of html.matchAll(/<(?:script|img|iframe|source|video|audio|embed|track)\b[^>]*>/gi)) add(attribute(tag, 'src'));
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload)\b/i.test(tag)) add(attribute(tag, 'href'));
  }
  for (const [, value] of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(value.trim());
  for (const [, value] of html.matchAll(/@import\s+["']([^"']+)["']/gi)) add(value);
  for (const [, body] of html.matchAll(scriptBody)) {
    for (const pattern of scriptLoads) for (const [, value] of body.matchAll(pattern)) add(value.trim());
  }
  return [...found];
}
