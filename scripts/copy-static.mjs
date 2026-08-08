/**
 * Copies the built UI from src/server/static into dist/server/static.
 *
 * The server resolves its static root relative to its own module URL, so the
 * assets have to sit at the same relative position in both trees. Vite writes
 * to the source tree (as the spec asks) and tsc only emits .ts, so nothing
 * would otherwise put them next to the compiled server for `npx`.
 */
import { cp, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/server/static/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/server/static/', import.meta.url));

const built = await stat(source).catch(() => null);
if (built === null) {
  console.error('No built UI at src/server/static — run `npm --prefix ui run build` first.');
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log('copied UI assets to dist/server/static');
