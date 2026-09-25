import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneDirectoryFor, cloneRepository, parseGitUrl, validateBranch } from './git-source.js';

describe('parseGitUrl', () => {
  it('normalises the common forms of a GitHub URL to one canonical HTTPS URL', () => {
    for (const input of [
      'https://github.com/Owner/Repo',
      'https://github.com/Owner/Repo.git',
      'https://github.com/Owner/Repo/',
      '  github.com/Owner/Repo  ',
      'https://GitHub.com/Owner/Repo.git/',
    ]) {
      const parsed = parseGitUrl(input);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.url).toBe('https://github.com/Owner/Repo');
      expect(parsed.value.segments).toEqual(['Owner', 'Repo']);
    }
  });

  it('accepts nested GitLab groups', () => {
    const parsed = parseGitUrl('https://gitlab.com/group/subgroup/project.git');
    expect(parsed.ok && parsed.value.segments).toEqual(['group', 'subgroup', 'project']);
  });

  it.each([
    ['git@github.com:owner/repo.git', 'SSH'],
    ['ssh://git@github.com/owner/repo', 'SSH'],
    ['http://github.com/owner/repo', 'https'],
    ['file:///C:/repos/thing', 'https'],
    ['ext::sh -c touch% /tmp/pwned', 'URL'],
    ['https://user:token@github.com/owner/repo', 'Credentials'],
    ['https://github.com/owner', 'must name a repository'],
    ['https://github.com/owner/repo?tab=readme', 'query'],
    ['https://github.com/owner/re po', 'not allowed'],
    ['', 'Enter a repository URL'],
  ])('refuses %s', (input, reason) => {
    const parsed = parseGitUrl(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(reason);
  });
});

describe('validateBranch', () => {
  it('accepts ordinary branch and tag names, and empty for the default branch', () => {
    expect(validateBranch('main')).toEqual({ ok: true, value: 'main' });
    expect(validateBranch('release/v1.2')).toEqual({ ok: true, value: 'release/v1.2' });
    expect(validateBranch('')).toEqual({ ok: true, value: '' });
  });

  it('refuses anything that could be read as an option or a path escape', () => {
    expect(validateBranch('--upload-pack=evil').ok).toBe(false);
    expect(validateBranch('a..b').ok).toBe(false);
    expect(validateBranch('main; rm -rf').ok).toBe(false);
  });
});

describe('cloneDirectoryFor', () => {
  it('gives each URL one stable folder under the base directory', () => {
    const parsed = parseGitUrl('https://github.com/owner/repo');
    if (!parsed.ok) throw new Error('fixture');
    expect(cloneDirectoryFor('/base', parsed.value).replace(/\\/g, '/')).toBe('/base/github.com/owner/repo');
  });
});

describe('cloneRepository (against a local repository, no network)', () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-git-source-'));
    origin = join(root, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    await writeFile(join(origin, 'index.ts'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['-C', origin, 'add', '.']);
    execFileSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clones the working tree and reports the commit it checked out', async () => {
    const destination = join(root, 'clones', 'local', 'repo');
    const result = await cloneRepository(`file://${origin.replace(/\\/g, '/')}`, destination);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Git for Windows may convert line endings on checkout; the content is what matters.
    const cloned = (await readFile(join(destination, 'index.ts'), 'utf8')).replace(/\r\n/g, '\n');
    expect(cloned).toBe('export const x = 1;\n');
    expect(result.value.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('replaces an earlier clone in the same folder rather than failing or merging', async () => {
    const destination = join(root, 'clones', 'repo');
    await cloneRepository(`file://${origin.replace(/\\/g, '/')}`, destination);
    await writeFile(join(destination, 'stale.txt'), 'left from before', 'utf8');
    const again = await cloneRepository(`file://${origin.replace(/\\/g, '/')}`, destination);
    expect(again.ok).toBe(true);
    expect(existsSync(join(destination, 'stale.txt'))).toBe(false);
  });

  it('reports a missing branch in plain words and leaves no half-made folder behind', async () => {
    const destination = join(root, 'clones', 'missing-branch');
    const result = await cloneRepository(`file://${origin.replace(/\\/g, '/')}`, destination, { branch: 'no-such-branch' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('branch does not exist');
    expect(existsSync(destination)).toBe(false);
  });
});
