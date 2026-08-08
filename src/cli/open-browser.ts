/**
 * Opens a URL in the user's default browser.
 *
 * Uses the platform's own opener rather than a dependency. Failure is not an
 * error worth stopping for — the URL is always printed to the terminal, so the
 * user can click or paste it either way.
 */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const [command, args] = openerFor(process.platform, url);

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {
      /* no opener available; the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* same */
  }
}

function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'win32') {
    // `start` is a cmd builtin; the empty string is the window title, which
    // `start` otherwise takes from the first quoted argument.
    return ['cmd', ['/c', 'start', '', url]];
  }
  if (platform === 'darwin') {
    return ['open', [url]];
  }
  return ['xdg-open', [url]];
}
