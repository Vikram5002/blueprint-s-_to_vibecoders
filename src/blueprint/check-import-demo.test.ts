/**
 * The named, re-runnable validation case for Type-1's central claim.
 *
 * Every other test in this directory exercises the mechanism with
 * hand-constructed fixtures. This one is different in kind, the same way
 * DRIFT.md's zod circular-import reproduction is different from its synthetic
 * violation tests: it runs the real pipeline — walk, parse, cluster, resolve
 * — end to end against a fixture repository checked into the tree
 * (`src/blueprint/fixtures/check-import-demo/`), compiles a genuinely
 * hand-authored rule the way `--blueprint=<file>` does, and calls the exact
 * `checkImport` function the MCP server exposes to an agent.
 *
 * It reproduces, as a pinned assertion rather than a session log, the live
 * demonstration run over stdio during Type-1's development: an agent asking
 * `check_import({ from: "api/a.ts", to: "db/b.ts" })` against a blueprint
 * that says "api must not import db" gets back `"forbidden"`, citing the
 * exact sentence a person wrote, before any violating code was generated.
 * That is the clearest single expression of this project's thesis available,
 * and it should not live only in a terminal transcript.
 *
 * Caveat this test does NOT remove: this is a constructed two-file repository,
 * not ground truth from an unrelated author (contrast the zod case, whose
 * evidentiary strength comes precisely from the maintainer never having heard
 * of this tool). What it demonstrates is that the mechanism works end to end
 * on a real pipeline run, not that the mechanism has been validated by anyone
 * other than this project. See docs/PAPER-OUTLINE.md's Type-1 section for how
 * that distinction is framed for the paper.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { analyseRepository } from '../pipeline/analyse.js';
import { candidatesFrom } from '../pipeline/intent.js';
import { compileBlueprint } from './dsl.js';
import { fileEdgesFrom } from '../conformance/graph-adapter.js';
import { checkImport } from '../mcp/check-import.js';
import { labelRepository } from '../pipeline/label-repository.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/check-import-demo/', import.meta.url));

describe('named validation case: check_import against a hand-authored rule', () => {
  it('answers "forbidden" before the violating import exists anywhere but in the fixture', async () => {
    // minClusterSize: 1 — the fixture is deliberately two one-file
    // directories, small enough that the default minimum (3) would merge
    // both into a single module and collapse the very directionality this
    // case demonstrates. Real repositories rarely hit that edge; this one
    // intentionally does, so it is worked around explicitly rather than
    // silently, the same way Week 9's own stability re-check calls out any
    // clustering decision that depends on a threshold.
    const analysed = await analyseRepository({ root: FIXTURE, cluster: { minClusterSize: 1 } });
    if (!analysed.ok) throw new Error(analysed.error.message);

    const labels = await labelRepository({
      root: FIXTURE,
      clustering: analysed.value.clustering,
      files: analysed.value.parse.files,
      useModel: false,
    });
    const blueprintText = await readFile(`${FIXTURE}blueprint.txt`, 'utf8');
    const directories = [...new Set(analysed.value.clustering.modules.flatMap((m) => m.directories))].sort();

    const compiled = compileBlueprint({
      text: blueprintText,
      location: `${FIXTURE}blueprint.txt`,
      modules: candidatesFrom(analysed.value.clustering, labels),
      directories,
    });

    // The rule this session authored by hand, exactly as written.
    expect(compiled.rejected).toEqual([]);
    expect(compiled.constraints).toHaveLength(1);
    expect(compiled.constraints[0]?.rawText).toBe('api must not import db');
    expect(compiled.constraints[0]?.source.type).toBe('user-authored');

    // The exact function the MCP server's check_import tool calls.
    const result = checkImport({
      from: 'api/a.ts',
      to: 'db/b.ts',
      constraints: compiled.constraints,
      clustering: analysed.value.clustering,
      fileEdges: fileEdgesFrom(analysed.value.graph),
    });

    expect(result.verdict).toBe('forbidden');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rawText).toBe('api must not import db');
    expect(result.findings[0]?.relation).toBe('must-not-import');
    expect(result.explanation).toContain('api must not import db');
  });

  it('answers "allowed" for an import the rule does not forbid', async () => {
    // minClusterSize: 1 — the fixture is deliberately two one-file
    // directories, small enough that the default minimum (3) would merge
    // both into a single module and collapse the very directionality this
    // case demonstrates. Real repositories rarely hit that edge; this one
    // intentionally does, so it is worked around explicitly rather than
    // silently, the same way Week 9's own stability re-check calls out any
    // clustering decision that depends on a threshold.
    const analysed = await analyseRepository({ root: FIXTURE, cluster: { minClusterSize: 1 } });
    if (!analysed.ok) throw new Error(analysed.error.message);

    const labels = await labelRepository({
      root: FIXTURE,
      clustering: analysed.value.clustering,
      files: analysed.value.parse.files,
      useModel: false,
    });
    const blueprintText = await readFile(`${FIXTURE}blueprint.txt`, 'utf8');
    const directories = [...new Set(analysed.value.clustering.modules.flatMap((m) => m.directories))].sort();
    const compiled = compileBlueprint({
      text: blueprintText,
      location: `${FIXTURE}blueprint.txt`,
      modules: candidatesFrom(analysed.value.clustering, labels),
      directories,
    });

    const result = checkImport({
      from: 'db/b.ts',
      to: 'api/a.ts',
      constraints: compiled.constraints,
      clustering: analysed.value.clustering,
      fileEdges: fileEdgesFrom(analysed.value.graph),
    });

    // The rule is one-directional; db -> api was never forbidden.
    expect(result.verdict).toBe('allowed');
  });
});
