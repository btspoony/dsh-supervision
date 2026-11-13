import { readFileSync } from 'node:fs';

const manifestUrl = new URL('../package.json', import.meta.url);
const manualUrl = new URL('../skills/use-dsh-sup/SKILL.md', import.meta.url);

/** The CLI and the plugin are released together, so this is also the required plugin version. */
export function version(): string {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version: string };
  return manifest.version;
}

/** Drops the leading YAML frontmatter block; the body is what `--skill` prints. */
function body(markdown: string): string {
  const end = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 3) : -1;
  return end === -1 ? markdown : markdown.slice(end + 5);
}

/** `--skill` output: the packaged manual with the version filled in, ending in one newline. */
export function skillText(): string {
  return `${body(readFileSync(manualUrl, 'utf8')).trim().replaceAll('{{version}}', version())}\n`;
}
