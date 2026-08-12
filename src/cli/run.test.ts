import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from './run.js';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-cli-'));
  createdRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }
  return root;
}

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { writeOut: (line) => out.push(line), writeErr: (line) => err.push(line) },
    out,
    err,
  };
}

describe('runCli', () => {
  it('prints a file-count summary for a real directory', async () => {
    const root = await makeRepo({ 'src/index.ts': '', 'main.py': '', 'README.md': '' });
    const { io, out } = captureIo();

    const code = await runCli([root, '--no-serve'], io, '0.1.0');

    expect(code).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('Files to analyse');
    expect(text).toContain('TypeScript');
    expect(text).toContain('Python');
  });

  it('emits parseable JSON with --json and nothing on stderr', async () => {
    const root = await makeRepo({ 'src/index.ts': 'export const a = 1;' });
    const { io, out, err } = captureIo();

    const code = await runCli([root, '--json'], io, '0.1.0');

    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);

    const payload: unknown = JSON.parse(out.join('\n'));
    expect(payload).toMatchObject({
      files: [{ path: 'src/index.ts', language: 'typescript' }],
      summary: { fileCount: 1 },
    });
  });

  it('lists every file with --verbose', async () => {
    const root = await makeRepo({ 'a.ts': '', 'b/c.py': '' });
    const { io, out } = captureIo();

    await runCli([root, '--verbose', '--no-serve'], io, '0.1.0');

    const text = out.join('\n');
    expect(text).toContain('a.ts');
    expect(text).toContain('b/c.py');
  });

  it('returns a usage exit code for a bad flag', async () => {
    const { io } = captureIo();
    expect(await runCli(['--nope'], io, '0.1.0')).toBe(EXIT_USAGE);
  });

  it('returns a failure exit code for a missing path, and creates nothing', async () => {
    // Regression: opening the correction database used to run before the path
    // was validated, and it creates .vibe/ under the root — so a mistyped path
    // was silently created and then reported as an empty repository.
    const { io, err } = captureIo();
    const missing = join(tmpdir(), `vibe-missing-${randomUUID()}`);

    const code = await runCli([missing, '--no-serve'], io, '0.1.0');

    expect(code).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('does not exist');
    expect(existsSync(missing)).toBe(false);
  });

  describe('--blueprint (Type-1 authoring)', () => {
    it('compiles an authored rule, reports a violation for it, and writes the spec/JSON outputs', async () => {
      const root = await makeRepo({
        'api/a.ts': "import { b } from '../db/b';\nexport const a = b;\n",
        'db/b.ts': 'export const b = 1;\n',
      });
      const blueprintPath = join(root, 'blueprint.txt');
      await writeFile(blueprintPath, 'api must not import db\n', 'utf8');

      const { io, out } = captureIo();
      const code = await runCli([root, '--json', `--blueprint=${blueprintPath}`], io, '0.1.0');

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(out.join('\n')) as {
        intent: { constraints: { source: { type: string } }[] };
        conformance: { violations: { constraint: { relation: string; source: { type: string } } }[] };
      };

      const authored = payload.intent.constraints.filter((c) => c.source.type === 'user-authored');
      expect(authored).toHaveLength(1);

      const authoredViolations = payload.conformance.violations.filter(
        (v) => v.constraint.source.type === 'user-authored',
      );
      expect(authoredViolations).toHaveLength(1);
      expect(authoredViolations[0]?.constraint.relation).toBe('must-not-import');

      expect(existsSync(join(root, '.vibe', 'blueprint-spec.md'))).toBe(true);
      expect(existsSync(join(root, '.vibe', 'blueprint-constraints.json'))).toBe(true);
    });

    it('persists the authored constraint into a later run that omits --blueprint', async () => {
      const root = await makeRepo({
        'api/a.ts': "import { b } from '../db/b';\nexport const a = b;\n",
        'db/b.ts': 'export const b = 1;\n',
      });
      const blueprintPath = join(root, 'blueprint.txt');
      await writeFile(blueprintPath, 'api must not import db\n', 'utf8');

      const first = captureIo();
      await runCli([root, '--json', `--blueprint=${blueprintPath}`], first.io, '0.1.0');

      // A later run — no --blueprint flag at all — must still see the rule
      // that was authored and stored in the previous run. This is the
      // verification loop from Part D: author once, then every subsequent
      // run (including an agent's) checks against it automatically.
      const second = captureIo();
      const code = await runCli([root, '--json'], second.io, '0.1.0');

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(second.out.join('\n')) as {
        intent: { constraints: { source: { type: string } }[] };
      };
      expect(payload.intent.constraints.some((c) => c.source.type === 'user-authored')).toBe(true);
    });

    it('reports a line that failed to compile without crashing the run', async () => {
      const root = await makeRepo({ 'a.ts': '' });
      const blueprintPath = join(root, 'blueprint.txt');
      await writeFile(blueprintPath, 'this is not a valid rule\n', 'utf8');

      const { io, err } = captureIo();
      const code = await runCli([root, '--no-serve', `--blueprint=${blueprintPath}`], io, '0.1.0');

      expect(code).toBe(EXIT_OK);
      expect(err.join('\n')).toContain('1 line(s) rejected');
    });
  });

  it('prints help and the version without scanning', async () => {
    const help = captureIo();
    expect(await runCli(['--help'], help.io, '0.1.0')).toBe(EXIT_OK);
    expect(help.out.join('\n')).toContain('Usage:');

    const version = captureIo();
    expect(await runCli(['--version'], version.io, '0.1.0')).toBe(EXIT_OK);
    expect(version.out).toEqual(['0.1.0']);
  });
});
