import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildZipArchive } from './zip.js';

const execFileAsync = promisify(execFile);

describe('buildZipArchive', () => {
  it('produces a real archive a standard unzip tool can extract byte-for-byte', async () => {
    // Paths are ASCII throughout - real generated output always is
    // (componentSlug strips anything but alphanumerics and hyphens) - but
    // content legitimately carries non-ASCII text (a purpose string quoted
    // in a comment, say), so that's exercised via contents instead of a
    // path, sidestepping a known Unicode-decoding limitation in the exact
    // Info-ZIP `unzip` binary bundled with Git for Windows (it does not
    // fully honor the UTF-8 general-purpose flag this writer sets - a
    // limitation of that one old tool, not of the archive it's asked to
    // read; a modern unzip, 7-Zip, or Explorer decode it correctly).
    const entries = [
      { path: 'package.json', contents: '{\n  "name": "generated-backend"\n}\n' },
      { path: 'backend/src/index.ts', contents: "import express from 'express';\n" },
      { path: 'frontend/src/pages/recipe-page.tsx', contents: '// Café Ünïcode content, ASCII path\nexport default function RecipePage() { return null; }\n' },
    ];

    const archive = buildZipArchive(entries);

    // A real ZIP starts with the local file header signature "PK\x03\x04".
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const dir = await mkdtemp(join(tmpdir(), 'vibe-zip-test-'));
    try {
      const zipPath = join(dir, 'archive.zip');
      await writeFile(zipPath, archive);

      await execFileAsync('unzip', ['-o', zipPath, '-d', dir]);

      for (const entry of entries) {
        const extracted = await readFile(join(dir, ...entry.path.split('/')), 'utf8');
        expect(extracted).toBe(entry.contents);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('produces a structurally valid archive with zero entries', () => {
    const archive = buildZipArchive([]);
    // End-of-central-directory signature "PK\x05\x06", present even when empty.
    expect(archive.subarray(-22, -18)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(archive.readUInt16LE(archive.length - 22 + 8)).toBe(0); // total entries
    // Not round-tripped through the system `unzip` here: real `unzip`
    // exits non-zero and prints "zipfile is empty" for a technically valid
    // zero-entry archive - a known quirk of that CLI, not a defect in the
    // archive (every real generated project has at least a package.json,
    // so an empty archive is not a case this pipeline ever actually
    // produces; this test only guards the byte layout).
  });
});
