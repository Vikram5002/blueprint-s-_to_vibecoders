/**
 * How a source location is written into an exported file.
 *
 * AGENTS.md is usually committed and blueprint.html is made to be shared, so
 * neither may carry a path from the machine that produced it: an absolute
 * path means nothing on anyone else's machine and exposes the local user
 * name (C:/Users/<name>/...). A location inside the repository is written
 * relative to it; one outside (a --blueprint file kept elsewhere) is reduced
 * to its file name.
 */
import { basename, isAbsolute, relative, sep } from 'node:path';

export function displayLocation(root: string, location: string): string {
  if (!isAbsolute(location)) return location.replace(/\\/g, '/');
  const inside = relative(root, location);
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
    return inside.split(sep).join('/');
  }
  return basename(location);
}

/** The repository's own folder name: enough to say which project a report is about. */
export function displayRoot(root: string): string {
  return basename(root.replace(/[\\/]+$/, '')) || root;
}
