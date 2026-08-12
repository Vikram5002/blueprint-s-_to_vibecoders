/**
 * Language detection by file extension.
 *
 * CLAUDE.md: do not add languages beyond TypeScript, JavaScript, Python and PHP.
 * PHP was added after Week 1; the extension list otherwise follows
 * docs/PHASE-1-SPEC.md, Week 1.
 */

export type Language = 'typescript' | 'javascript' | 'python' | 'php';

export const SUPPORTED_LANGUAGES: readonly Language[] = [
  'typescript',
  'javascript',
  'python',
  'php',
];

const EXTENSION_TO_LANGUAGE = new Map<string, Language>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.php', 'php'],
]);

export const SUPPORTED_EXTENSIONS: readonly string[] = [...EXTENSION_TO_LANGUAGE.keys()];

/**
 * Returns the language for a path, or `null` if the extension is not supported.
 * Matching is case-insensitive: Windows and macOS filesystems routinely hand
 * back `.TS` or `.PY`.
 */
export function detectLanguage(filePath: string): Language | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot <= 0) {
    return null;
  }

  const extension = filePath.slice(lastDot).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(extension) ?? null;
}
