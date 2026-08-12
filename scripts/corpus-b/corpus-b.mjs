/**
 * Corpus B: run conformance against constraints parsed from real
 * machine-checkable configs, rather than from prose.
 *
 * Entirely deterministic — no model is consulted at any point. Config parsing,
 * subject resolution and violation detection are all offline, so this costs no
 * quota and is exactly reproducible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('file:///D:/project%20blue%20print/dist/');
const { runPipeline } = await import(new URL('pipeline/run.js', dist).href);
const { resolveSubject, resolveRegexSubject, summariseSubjects } = await import(new URL('conformance/resolve-subject.js', dist).href);
const { detectViolations } = await import(new URL('conformance/violations.js', dist).href);
const { fileEdgesFrom, unresolvedByFile } = await import(new URL('conformance/graph-adapter.js', dist).href);

const MAPPING = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const HITS = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const SCRATCH = process.argv[4];
const OUT = process.argv[5];

const urlFor = (repo) => `https://github.com/${repo}.git`;

/** A config rule becomes a Constraint with STATED provenance and a real source. */
function toConstraint(rule, index, repo, configPath) {
  return {
    id: `cfg-${index}-${(rule.name || 'unnamed').replace(/\W+/g, '-').slice(0, 40)}`,
    relation: rule.relation,
    rawPhrase: { subject: rule.subject, object: rule.object, via: rule.via ?? null },
    source: { type: 'user-authored', location: configPath, line: null, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: `${rule.name}: ${rule.relation}(${rule.subject} -> ${rule.object ?? ''})`,
    provenance: 'STATED',
  };
}

/** dependency-cruiser paths are regexes; turn the common shapes into a prefix. */
/**
 * Config paths are regexes and are passed through as regexes.
 *
 * The first version reduced them to a path prefix and bound 2 of 1,300
 * constraints — a config regex is seldom a prefix, and `^(packages/[^/]+)/src/`
 * has no usable one at all. `resolveRegexSubject` matches the pattern against
 * real file paths instead.
 *
 * This now only filters out the placeholder strings the mapper emits for rules
 * with no concrete source or target side.
 */
function toPhrase(pattern) {
  if (!pattern) return null;
  const placeholder = ['(any module)', '(whole repo)', '(anything else)', '(each other)'];
  if (placeholder.includes(String(pattern))) return null;
  return String(pattern);
}


const results = [];
mkdirSync(SCRATCH, { recursive: true });

for (const entry of MAPPING) {
  if (entry.parseError || entry.total === 0) continue;
  const hit = HITS.find((h) => h.repo === entry.repo);
  if (!hit) continue;

  const mapped = entry.rules.filter((r) => r.mapped);
  console.log(`\n=== ${entry.repo} — ${mapped.length} mapped rule(s) ===`);

  const dir = join(SCRATCH, entry.repo.replace('/', '__'));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  try {
    /**
     * core.longpaths, and a short-clone check afterwards.
     *
     * Without it Windows fails checkout on deep paths and leaves a directory
     * that parses cleanly but is missing files — the Week 9 short clone and
     * the rollup fragment, both recorded in FINDINGS.md as Finding 5. The main
     * harness has guarded this since Week 9; this script did not, and reproduced
     * the same failure on four of five repositories.
     */
    const out = execFileSync(
      'git',
      ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch', urlFor(entry.repo), dir],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    if (/filename too long|unable to create file|unable to checkout|cannot create/i.test(String(out))) {
      console.log('  clone looks short (path-length failure) — skipping rather than measuring a fragment');
      continue;
    }
  } catch (e) { console.log('  clone failed:', String(e.message).slice(0, 160)); continue; }

  const run = await runPipeline({ root: dir, useModel: false });
  if (!run.ok) { console.log('  analysis failed:', run.error.message); continue; }
  const value = run.value;
  value.db.close();

  // Resolve each rule's phrases against the real module graph.
  const phrases = [];
  for (const [i, rule] of mapped.entries()) {
    const s = toPhrase(rule.subject);
    const o = rule.relation === 'must-not-cycle' ? null : toPhrase(rule.object);
    if (s === null || (rule.relation !== 'must-not-cycle' && o === null)) continue;
    phrases.push({ i, rule, s, o, via: toPhrase(rule.via) });
  }

  const candidates = value.analysis.clustering.modules.map((m) => ({
    moduleId: m.id, label: value.labels.labels.get(m.id)?.label ?? m.label,
    files: m.files, directories: m.directories,
  }));
  const allDirectories = [...new Set(value.analysis.clustering.modules.flatMap((m) => m.directories))];
  /**
   * The config's own scan filters, applied before anything is resolved.
   *
   * dependency-cruiser never sees a file its `exclude` matches, so a violation
   * found in one is a file the tool would not have looked at. Ignoring this
   * produced all three prisma "violations" — every one in a `/test/` path that
   * prisma's config excludes — and the sverweij one, in a file whose name
   * contains "fixtures". Hand-verifying them is what surfaced it.
   */
  const scan = entry.scan ?? {};
  const toRe = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => new RegExp(x)));
  const excludes = toRe(scan.exclude);
  const includeOnly = toRe(scan.includeOnly);
  const inScope = (f) =>
    (includeOnly.length === 0 || includeOnly.some((re) => re.test(f))) &&
    !excludes.some((re) => re.test(f));

  const allFiles = [...value.analysis.clustering.modules.flatMap((m) => m.files)].sort();
  const files = allFiles.filter(inScope);
  const excluded = allFiles.length - files.length;
  if (excluded > 0) console.log(`  config scan filters exclude ${excluded} of ${allFiles.length} files`);
  const moduleByFile = new Map();
  for (const m of value.analysis.clustering.modules) {
    for (const f of m.files) if (inScope(f)) moduleByFile.set(f, m.id);
  }

  /**
   * Anything carrying regex syntax goes to the regex resolver; the rest is
   * treated as prose. The two are summarised separately because they fail for
   * unrelated reasons.
   */
  const REGEXY = new RegExp('[' + '^$()[]*+?|' .split('').map((c) => '\\' + c).join('') + ']');
  const resolve = (phrase) =>
    REGEXY.test(phrase)
      ? resolveRegexSubject(phrase, { files, moduleByFile })
      : resolveSubject(phrase, { candidates, directories: allDirectories });

  const constraints = [];
  let unresolvedRoles = 0;
  for (const p of phrases) {
    const subject = resolve(p.s);
    const object = p.o === null ? null : resolve(p.o);
    const via = p.via === null ? null : resolve(p.via);
    if (subject.status === 'UNRESOLVED') unresolvedRoles += 1;
    if (object && object.status === 'UNRESOLVED') unresolvedRoles += 1;

    constraints.push({
      ...toConstraint(p.rule, p.i, entry.repo, hit.path),
      subject,
      object: object ?? subject,
      via,
    });
  }

  // Edges are filtered to the config's scan scope for the same reason.
  const conformance = detectViolations({
    constraints,
    clustering: value.analysis.clustering,
    fileEdges: fileEdgesFrom(value.analysis.graph).filter((e) => inScope(e.from) && inScope(e.to)),
    unresolvedByFile: unresolvedByFile(value.analysis.graph),
  });

  const r = {
    repo: entry.repo, tool: entry.tool, configPath: hit.path,
    rulesTotal: entry.total, rulesMapped: mapped.length,
    constraintsBuilt: constraints.length, unresolvedRoles,
    resolution: summariseSubjects(
      constraints.flatMap((c) => [c.subject, c.object, c.via].filter((x) => x != null)),
    ),
    modules: value.analysis.clustering.modules.length,
    files: value.analysis.parse.files.length,
    checked: conformance.summary.checked,
    unchecked: conformance.summary.unchecked,
    satisfied: conformance.summary.satisfied,
    violated: conformance.summary.violated,
    violations: conformance.summary.violations,
    bySeverity: conformance.summary.bySeverity,
    examples: conformance.violations.slice(0, 5).map((v) => ({
      kind: v.kind, severity: v.severity, explanation: v.explanation,
      rule: v.constraint.rawText,
      evidence: v.edges[0]?.evidence?.[0] ? `${v.edges[0].evidence[0].file}:${v.edges[0].evidence[0].line}` : null,
    })),
  };
  results.push(r);
  console.log(`  ${r.files} files, ${r.modules} modules | constraints ${r.constraintsBuilt} (checked ${r.checked}, unchecked ${r.unchecked})`);
  console.log(`  VIOLATIONS: ${r.violations}  (high ${r.bySeverity.high}, medium ${r.bySeverity.medium}, low ${r.bySeverity.low})`);
  for (const e of r.examples) console.log(`    [${e.severity}] ${e.kind}: ${e.explanation.slice(0, 110)}`);
  rmSync(dir, { recursive: true, force: true });
}

writeFileSync(OUT, JSON.stringify(results, null, 2));
const tot = (f) => results.reduce((s, r) => s + f(r), 0);
console.log(`\n=== CORPUS B ===`);
console.log(`  repos analysed   ${results.length}`);
console.log(`  constraints      ${tot((r) => r.constraintsBuilt)} built, ${tot((r) => r.checked)} checked, ${tot((r) => r.unchecked)} unchecked`);
console.log(`  VIOLATIONS       ${tot((r) => r.violations)}`);
