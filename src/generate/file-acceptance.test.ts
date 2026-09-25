import { describe, expect, it } from 'vitest';
import { createFileJudge, type FileAcceptanceInput } from './file-acceptance.js';

const clean: FileAcceptanceInput = {
  installOk: true,
  buildOk: true,
  buildOutput: '',
  buildOutputTruncated: false,
  violations: [],
  locatorFindings: [],
  runtimeStarted: true,
  routeResults: [
    { targetPath: 'backend/src/routes/a.ts', passed: true },
    { targetPath: 'backend/src/routes/b.ts', passed: true },
  ],
};

const tscFailure = [
  '> tsc',
  '',
  "backend/src/routes/b.ts(10,23): error TS2339: Property 'user' does not exist.",
  "frontend/src/pages/page.tsx(40,3): error TS2322: Type 'Element' is not assignable to type 'FC'.",
  '  Type continuation line.',
].join('\n');

describe('createFileJudge', () => {
  it('accepts every file of a clean project', () => {
    const judge = createFileJudge(clean);
    expect(judge('backend/src/routes/a.ts')).toEqual([]);
    expect(judge('frontend/src/pages/page.tsx')).toEqual([]);
  });

  it('rejects only the files tsc names, and route owners it could not check', () => {
    const judge = createFileJudge({ ...clean, buildOk: false, buildOutput: tscFailure, runtimeStarted: false });
    expect(judge('backend/src/routes/b.ts')).toEqual(['build-failed', 'runtime-not-checked']);
    expect(judge('frontend/src/pages/page.tsx')).toEqual(['build-failed']);
    expect(judge('backend/src/routes/a.ts')).toEqual(['runtime-not-checked']);
    expect(judge('backend/src/db/table.ts')).toEqual([]);
  });

  it('rejects every file when the build output was cut at the cap', () => {
    const judge = createFileJudge({ ...clean, buildOk: false, buildOutput: tscFailure, buildOutputTruncated: true });
    expect(judge('backend/src/db/table.ts')).toEqual(['build-failed']);
  });

  it('rejects every file when a failed build names no file', () => {
    const judge = createFileJudge({ ...clean, buildOk: false, buildOutput: 'error TS5023: Unknown compiler option.' });
    expect(judge('backend/src/db/table.ts')).toEqual(['build-failed']);
  });

  it('rejects every file when the install failed', () => {
    expect(createFileJudge({ ...clean, installOk: false })('backend/src/db/table.ts')).toEqual(['install-failed']);
  });

  it('blames the importing file of a violation, not its target', () => {
    const judge = createFileJudge({
      ...clean,
      violations: [{ edges: [{ fromFile: 'backend/src/routes/a.ts' }] }],
    });
    expect(judge('backend/src/routes/a.ts')).toEqual(['blueprint-violation']);
    expect(judge('backend/src/db/table.ts')).toEqual([]);
  });

  it('rejects every file for a violation it cannot attribute', () => {
    const judge = createFileJudge({ ...clean, violations: [{}] });
    expect(judge('backend/src/db/table.ts')).toEqual(['blueprint-violation']);
  });

  it('rejects the file holding a locator finding', () => {
    const judge = createFileJudge({ ...clean, locatorFindings: [{ file: '.\\backend\\src\\routes\\b.ts' }] });
    expect(judge('backend/src/routes/b.ts')).toEqual(['service-locator-finding']);
    expect(judge('backend/src/routes/a.ts')).toEqual([]);
  });

  it('rejects only the route owner whose route failed', () => {
    const judge = createFileJudge({
      ...clean,
      routeResults: [
        { targetPath: 'backend/src/routes/a.ts', passed: true },
        { targetPath: 'backend/src/routes/b.ts', passed: false },
      ],
    });
    expect(judge('backend/src/routes/b.ts')).toEqual(['runtime-route-failed']);
    expect(judge('backend/src/routes/a.ts')).toEqual([]);
  });

  it('rejects every file when a built server never started', () => {
    expect(createFileJudge({ ...clean, runtimeStarted: false })('backend/src/db/table.ts')).toEqual(['runtime-not-started']);
  });
});
