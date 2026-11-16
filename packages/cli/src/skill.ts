import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL('../package.json', import.meta.url);
const manualUrl = new URL('../skills/use-dsh-sup/SKILL.md', import.meta.url);

/**
 * Reads one packaged file. `--version` and `--skill` are informational, so a
 * broken install must name the file it could not read: the caller prints the
 * message as one stderr line and exits 2 instead of crashing.
 */
function readPackaged(url: URL): string {
  try {
    return readFileSync(url, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${fileURLToPath(url)}: ${reason}`);
  }
}

/** The CLI and the plugin are released together, so this is also the required plugin version. */
export function version(): string {
  const manifest = JSON.parse(readPackaged(manifestUrl)) as { version: string };
  return manifest.version;
}

/** Drops the leading YAML frontmatter block; the body is what `--skill` prints. */
function body(markdown: string): string {
  const end = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 3) : -1;
  return end === -1 ? markdown : markdown.slice(end + 5);
}

/** `--skill` output: the packaged manual with the version filled in, ending in one newline. */
export function skillText(): string {
  return `${body(readPackaged(manualUrl)).trim().replaceAll('{{version}}', version())}\n`;
}
