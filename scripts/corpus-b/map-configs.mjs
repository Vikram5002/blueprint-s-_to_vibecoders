/**
 * Maps real architecture-rule configs onto the project's four Constraint
 * relations, and reports what does not map.
 *
 * The coverage number is the result: it measures how much of what these tools
 * express is expressible as a dependency rule between two named parts of a
 * repository, which is the only thing an import graph can decide.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DIR = process.argv[2];
const OUT = process.argv[3];

/** Our four relations, plus the reasons a rule falls outside them. */
const UNMAPPABLE = {
  'orphan-detection': 'flags unreachable modules; not a rule between two parts',
  'dependency-type': 'constrains *kind* of dependency (core, npm, dev) not module pairs',
  'resolution-health': 'flags unresolvable or missing imports; a build concern',
  'license-or-metadata': 'about package metadata, not structure',
  'reachability': 'asks whether a path exists at all, not whether one is forbidden',
  'unknown-shape': 'rule shape not recognised by this mapper',
  'capture-group-backreference': 'uses $1 to mean "each package independently"; one constraint cannot say that',
  'exclusion-not-expressible': 'the rule forbids a set MINUS an exception set; our relations have no exception side',
};

/** `$1`-style backreference anywhere in a rule makes it per-capture, not global. */
function hasBackreference(rule) {
  return JSON.stringify(rule).includes('$1') || /\$\d/.test(JSON.stringify(rule));
}

// ---------- dependency-cruiser ----------

async function parseDependencyCruiser(file) {
  const mod = await import(pathToFileURL(file).href);
  const config = mod.default ?? mod;
  const rules = [...(config.forbidden ?? []), ...(config.required ?? [])];
  /**
   * The scan filters, carried alongside the rules.
   *
   * dependency-cruiser never sees a file that `exclude` matches, so a
   * violation reported in one is a file the tool would not have looked at.
   * All three prisma "violations" were in `/test/`, which its config excludes.
   */
  parseDependencyCruiser.lastOptions = {
    exclude: config.options?.exclude?.path ?? config.options?.exclude ?? null,
    includeOnly: config.options?.includeOnly?.path ?? config.options?.includeOnly ?? null,
  };

  return rules.map((rule) => {
    const from = rule.from ?? {};
    const to = rule.to ?? {};
    const name = rule.name ?? '(unnamed)';

    /**
     * Refused before anything else, and this is the important guard.
     *
     * `src-to-other-sub-paths-with-subpath-imports-only` is
     * `from: '(^src/[^/]+/)', to: { path: '^src/', pathNot: '$1' }` — "each
     * subfolder may import src, but not itself". Read without the pathNot it
     * becomes "no src subfolder may import src", which fires on 226 files of
     * perfectly legal code. That false positive was produced, hand-verified
     * and traced back to here.
     */
    if (hasBackreference(rule)) {
      return { name, mapped: false, reason: 'capture-group-backreference' };
    }
    /**
     * A forbidden set with an exception set is not one of our four relations.
     * Dropping the exception widens the rule silently, which is the same
     * failure in a milder form.
     */
    if (to.path && to.pathNot) {
      return { name, mapped: false, reason: 'exclusion-not-expressible' };
    }
    if (to.dependencyTypesNot && (to.path || to.pathNot)) {
      return { name, mapped: false, reason: 'exclusion-not-expressible' };
    }

    if (to.circular === true) {
      return { name, mapped: true, relation: 'must-not-cycle', subject: from.path ?? '(whole repo)', object: null };
    }
    if (to.orphan === true) return { name, mapped: false, reason: 'orphan-detection' };
    if (to.couldNotResolve === true || to.moreThanOneDependencyType) {
      return { name, mapped: false, reason: 'resolution-health' };
    }
    // `dependencyTypesNot` alongside a path pair is a qualifier on a real
    // structural rule, not a rule about dependency kinds — only treat it as
    // the latter when there is no path on either side.
    if (to.dependencyTypesNot && !to.path && !to.pathNot && !from.path) {
      return { name, mapped: false, reason: 'dependency-type' };
    }
    if (to.dependencyTypes && !to.path) return { name, mapped: false, reason: 'dependency-type' };
    if (to.license || to.licenseNot) return { name, mapped: false, reason: 'license-or-metadata' };
    if (to.reachable !== undefined || to.numberOfDependentsLessThan !== undefined) {
      return { name, mapped: false, reason: 'reachability' };
    }
    /**
     * `from.path` with `to.pathNot` is an allow-list: "this may import only
     * these". That is `may-only-import-via` — the permitted set is the route.
     *
     * Missed on the first pass, which only looked at `to.path`, and it
     * understated coverage by counting real architectural rules
     * (`cli-to-main-only`, `bin-to-cli-only`, `report-stays-in-report`) as
     * build hygiene.
     */
    if (from.path && to.pathNot && !to.path) {
      const permitted = Array.isArray(to.pathNot) ? to.pathNot : [to.pathNot];
      return {
        name, mapped: true, relation: 'may-only-import-via',
        subject: String(from.path), object: '(anything else)',
        via: permitted.map(String).join(' | '),
      };
    }
    // A rule naming a source path and a target path is a forbidden import.
    if (from.path && to.path) {
      const viaOnly = to.viaOnly ?? to.via;
      return {
        name,
        mapped: true,
        relation: viaOnly ? 'may-only-import-via' : 'must-not-import',
        subject: String(from.path),
        object: String(to.path),
        ...(viaOnly ? { via: String(viaOnly) } : {}),
      };
    }
    if (to.path && !from.path) {
      return { name, mapped: true, relation: 'must-not-import', subject: '(any module)', object: String(to.path) };
    }
    return { name, mapped: false, reason: 'unknown-shape' };
  });
}

// ---------- import-linter ----------

function parseImportLinter(file) {
  const text = readFileSync(file, 'utf8');
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const header = /^\[importlinter:contract:(.+)\]/.exec(line);
    if (header) { current = { id: header[1], body: {} }; sections.push(current); continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const kv = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) { current.last = kv[1]; current.body[kv[1]] = kv[2].trim(); }
    else if (line.trim() !== '' && current.last) {
      current.body[current.last] = `${current.body[current.last]}\n${line.trim()}`.trim();
    }
  }

  return sections.map((s) => {
    const type = (s.body.type ?? '').trim();
    const name = (s.body.name ?? s.id).trim();
    const layers = (s.body.layers ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

    if (type === 'layers') {
      // A layers contract is a stack of must-be-layer-above rules, one per
      // ordered pair — which is exactly how the relation is defined.
      return {
        name, mapped: true, relation: 'must-be-layer-above',
        subject: layers[0] ?? '', object: layers[layers.length - 1] ?? '',
        expandsTo: (layers.length * (layers.length - 1)) / 2, layers,
      };
    }
    if (type === 'acyclic_siblings' || type === 'acyclic') {
      return { name, mapped: true, relation: 'must-not-cycle', subject: (s.body.ancestors ?? '').trim(), object: null };
    }
    if (type === 'forbidden') {
      return {
        name, mapped: true, relation: 'must-not-import',
        subject: (s.body.source_modules ?? '').replace(/\n/g, ', '),
        object: (s.body.forbidden_modules ?? '').replace(/\n/g, ', '),
      };
    }
    if (type === 'independence') {
      return {
        name, mapped: true, relation: 'must-not-import',
        subject: (s.body.modules ?? '').replace(/\n/g, ', '),
        object: '(each other)', mutual: true,
      };
    }
    return { name, mapped: false, reason: 'unknown-shape', type };
  });
}

// ---------- run ----------

const report = [];
for (const file of readdirSync(DIR)) {
  const full = join(DIR, file);
  const isDepCruise = /dependency.cruiser/i.test(file);
  const repo = file.split('__').slice(0, 2).join('/');
  let rules = [];
  try {
    rules = isDepCruise ? await parseDependencyCruiser(full) : parseImportLinter(full);
  } catch (cause) {
    console.log(`FAILED ${repo}: ${cause.message.slice(0, 100)}`);
    report.push({ repo, tool: isDepCruise ? 'dependency-cruiser' : 'import-linter', parseError: cause.message });
    continue;
  }
  const mapped = rules.filter((r) => r.mapped);
  const unmapped = rules.filter((r) => !r.mapped);
  report.push({
    repo, tool: isDepCruise ? 'dependency-cruiser' : 'import-linter',
    total: rules.length, mapped: mapped.length, unmapped: unmapped.length, rules,
    scan: isDepCruise ? (parseDependencyCruiser.lastOptions ?? null) : null,
  });
  console.log(`\n=== ${repo} (${isDepCruise ? 'dependency-cruiser' : 'import-linter'}) ===`);
  console.log(`  ${mapped.length}/${rules.length} rules map to our relations`);
  for (const r of mapped) {
    console.log(`   MAP  ${r.relation.padEnd(20)} ${r.name}${r.expandsTo ? ` (${r.layers.length} layers -> ${r.expandsTo} pairs)` : ''}`);
  }
  for (const r of unmapped) {
    console.log(`   ---  ${String(r.reason).padEnd(20)} ${r.name}`);
  }
}
writeFileSync(OUT, JSON.stringify(report, null, 2));

const t = report.filter((r) => !r.parseError);
const tot = t.reduce((s, r) => s + r.total, 0);
const map = t.reduce((s, r) => s + r.mapped, 0);
console.log(`\n=== COVERAGE ===`);
console.log(`  ${map} of ${tot} rules map (${((100 * map) / tot).toFixed(1)}%) across ${t.length} configs`);
const reasons = {};
for (const r of t) for (const x of r.rules) if (!x.mapped) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  unmapped: ${String(v).padStart(3)}  ${k} — ${UNMAPPABLE[k] ?? ''}`);
}
