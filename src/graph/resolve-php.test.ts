import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import type { ResolvedImport } from '../types/resolution.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function resolveFixture(name: string): Promise<ResolvedImport[]> {
  const root = `${FIXTURES}${name}`;

  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolved = await resolveRepository({ root, files: parsed.value.files });
  return [...resolved.imports];
}

function pick(all: readonly ResolvedImport[], file: string, specifier: string): ResolvedImport {
  const found = all.find((item) => item.record.evidence.file === file && item.record.specifier === specifier);
  if (found === undefined) {
    const seen = all
      .filter((i) => i.record.evidence.file === file)
      .map((i) => i.record.specifier)
      .join(', ');
    throw new Error(`no import "${specifier}" in ${file}; saw: ${seen}`);
  }
  return found;
}

describe('php-psr4: composer PSR-4 autoload mapping', () => {
  it('resolves a `use` to the PSR-4-mapped file', async () => {
    const all = await resolveFixture('php-psr4');
    const item = pick(all, 'src/Controller.php', 'App\\Models\\User');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/Models/User.php');
  }, 30_000);

  it('resolves an aliased `use`', async () => {
    const all = await resolveFixture('php-psr4');
    const item = pick(all, 'src/Controller.php', 'App\\Contracts\\HasName');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/Contracts/HasName.php');
  }, 30_000);

  it('resolves `use function`', async () => {
    const all = await resolveFixture('php-psr4');
    expect(pick(all, 'src/Controller.php', 'App\\Helpers\\format_name').targetPath).toBe(
      'src/Helpers/format_name.php',
    );
  }, 30_000);

  it('reports a PSR-4-mapped FQCN with no file as UNRESOLVED, never EXTERNAL', async () => {
    const all = await resolveFixture('php-psr4');
    const item = pick(all, 'src/Controller.php', 'App\\Missing\\Ghost');

    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('php-namespace-target-missing');
  }, 30_000);

  it('classifies a FQCN matching no registered prefix as EXTERNAL', async () => {
    const all = await resolveFixture('php-psr4');
    const item = pick(all, 'src/Api.php', 'Symfony\\Component\\HttpFoundation\\Response');

    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('php-composer-package');
  }, 30_000);

  it('expands a grouped use and resolves each member', async () => {
    const all = await resolveFixture('php-psr4');
    expect(pick(all, 'src/Api.php', 'App\\Models\\User').status).toBe('INTERNAL');
  }, 30_000);

  it('resolves through the autoload-dev PSR-4 prefix', async () => {
    const all = await resolveFixture('php-psr4');
    expect(pick(all, 'tests/UserTest.php', 'App\\Models\\User').status).toBe('INTERNAL');
  }, 30_000);
});

describe('php-psr4-split-prefix: the same namespace registered under two directories', () => {
  it('tries every directory registered under a shared prefix before giving up', async () => {
    const all = await resolveFixture('php-psr4-split-prefix');
    expect(pick(all, 'test/App/WidgetTest.php', 'App\\Widget').targetPath).toBe('src/App/Widget.php');
  }, 30_000);
});

describe('php-relative-require: __DIR__-relative require/include', () => {
  it('resolves require with __DIR__ concatenation', async () => {
    const all = await resolveFixture('php-relative-require');
    const item = pick(all, 'index.php', '/lib/bootstrap.php');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('lib/bootstrap.php');
  }, 30_000);

  it('resolves require_once the same way', async () => {
    const all = await resolveFixture('php-relative-require');
    expect(pick(all, 'index.php', '/lib/config.php').status).toBe('INTERNAL');
  }, 30_000);

  it('resolves a bare relative include against the file directory', async () => {
    const all = await resolveFixture('php-relative-require');
    expect(pick(all, 'index.php', 'lib/helpers.php').targetPath).toBe('lib/helpers.php');
  }, 30_000);

  it('reports a missing require target as UNRESOLVED with a reason', async () => {
    const all = await resolveFixture('php-relative-require');
    const item = pick(all, 'index.php', '/lib/missing.php');

    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('php-require-target-missing');
  }, 30_000);
});

describe('php-vendor: vendor/ requires and unmapped use classify as EXTERNAL', () => {
  it('classifies a require under vendor/ as EXTERNAL', async () => {
    const all = await resolveFixture('php-vendor');
    const item = pick(all, 'src/Bootstrap.php', '/../vendor/autoload_stub/autoload.php');

    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('php-composer-package');
  }, 30_000);

  it('classifies a require under vendor/ as EXTERNAL even when the file does not exist', async () => {
    const all = await resolveFixture('php-vendor');
    const item = pick(all, 'src/Bootstrap.php', '/../vendor/missing_package/autoload.php');

    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('php-composer-package');
  }, 30_000);

  it('classifies a use with no PSR-4 match as EXTERNAL', async () => {
    const all = await resolveFixture('php-vendor');
    const item = pick(all, 'src/Bootstrap.php', 'Monolog\\Logger');

    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('php-composer-package');
  }, 30_000);
});
