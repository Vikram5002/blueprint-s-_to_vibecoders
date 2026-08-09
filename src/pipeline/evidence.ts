/**
 * Evidence about a module, for the labelling prompt.
 *
 * CLAUDE.md: "Do not send file contents to the LLM in bulk. Send the graph."
 * So nothing here reads a file. Everything comes from the symbol table the
 * parser already produced — export names, and the export statements the
 * extractor kept as evidence in Week 2.
 *
 * That evidence turns out to be exactly the right thing to send: an export
 * statement is a one-line, already-truncated, genuinely representative sample
 * of what a file offers, and it cost nothing extra to obtain.
 *
 * Selection is deterministic. Ties break on name or path, so the same clustering
 * always produces the same prompt, which is what makes the response cache hit.
 */
import type { ParsedFile } from '../types/symbols.js';
import type { ClusteringResult } from '../types/modules.js';
import type { ClusterEvidence } from '../llm/label-modules.js';
import type { ClusterSnippet } from '../llm/prompt.js';

/** Names that say nothing about what a module does. */
const UNINFORMATIVE = new Set(['default', '*', 'index']);

interface ModuleEvidence {
  readonly symbols: readonly string[];
  readonly snippets: readonly ClusterSnippet[];
}

export function buildClusterEvidence(
  files: readonly ParsedFile[],
  clustering: ClusteringResult,
): ClusterEvidence {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const evidence = new Map<string, ModuleEvidence>();

  for (const module of clustering.modules) {
    evidence.set(module.id, collect(module.files, byPath));
  }

  return {
    symbols: (moduleId) => evidence.get(moduleId)?.symbols ?? [],
    snippets: (moduleId) => evidence.get(moduleId)?.snippets ?? [],
  };
}

function collect(
  modulePaths: readonly string[],
  byPath: ReadonlyMap<string, ParsedFile>,
): ModuleEvidence {
  const counts = new Map<string, number>();
  const parsed: ParsedFile[] = [];

  for (const path of modulePaths) {
    const file = byPath.get(path);
    if (file === undefined) {
      continue;
    }
    parsed.push(file);
    for (const exported of file.exports) {
      if (UNINFORMATIVE.has(exported.name)) {
        continue;
      }
      counts.set(exported.name, (counts.get(exported.name) ?? 0) + 1);
    }
  }

  // Most-repeated names first: a symbol several files export is more likely to
  // describe the module than one that appears once.
  const symbols = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  // Snippets come from the files with the most exports — the ones most likely
  // to be the module's surface rather than a helper.
  const snippets: ClusterSnippet[] = parsed
    .filter((file) => file.exports.length > 0)
    .sort((a, b) => b.exports.length - a.exports.length || a.path.localeCompare(b.path))
    .slice(0, 3)
    .flatMap((file) => {
      const first = file.exports[0];
      return first === undefined ? [] : [{ file: file.path, text: first.evidence.snippet }];
    });

  return { symbols, snippets };
}
