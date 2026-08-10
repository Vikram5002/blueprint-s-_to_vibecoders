/**
 * A single self-contained HTML file: the report, with no server behind it.
 *
 * ## Why not reuse the React UI
 *
 * The `ui/` bundle is a client of the JSON API — rule 4 says so, and that is
 * the right design while a server exists. But `file://` has no server, and a
 * bundle that fetches `/api/graph` from a local file produces exactly the
 * console errors this export is required not to produce. So the data is
 * inlined at generation time and rendered by a few dozen lines of vanilla
 * script. Nothing is fetched, because there is nothing to fetch from.
 *
 * ## No external requests at all
 *
 * No CDN, no font, no image, no analytics. Partly because it must work from a
 * double-click with no network, and partly because this is a local-first tool
 * that reads private source code: an export that phoned anywhere would be a
 * data leak wearing a report's clothes.
 *
 * The timestamp and commit are rendered in the header rather than a comment,
 * because a static file outlives the run that made it and a reader has no
 * other way to tell whether they are looking at today's measurement.
 */
import { buildViolationsResponse } from '../server/violations-api.js';
import { buildIntentResponse } from '../server/intent-api.js';
import type { AnalysisContext } from '../server/context.js';
import type { ExportMeta } from './agents-md.js';

/**
 * Escapes a JSON payload for embedding in a `<script>` element.
 *
 * `</script>` inside a string literal terminates the element no matter where
 * it appears, so a source file containing that text — entirely plausible in a
 * repository that renders HTML — would otherwise break the page and inject
 * whatever followed. The `<!--` case closes the same hole for HTML comments.
 */
export function escapeForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    /**
     * U+2028 and U+2029 are line terminators to a JavaScript parser but not
     * to JSON, so an unescaped one inside an embedded string is a syntax
     * error on the page. Written as escapes rather than literal characters --
     * a raw invisible character in source is exactly what
     * source-hygiene.test.ts exists to catch.
     */
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildExportPayload(context: AnalysisContext, meta: ExportMeta): unknown {
  const violations = buildViolationsResponse(context);
  const intent = buildIntentResponse(context);

  return {
    generatedAt: meta.generatedAt,
    commit: meta.commit,
    root: context.root,
    counts: {
      files: context.graph.graph.order,
      edges: context.graph.graph.size,
      modules: context.clustering.modules.length,
    },
    modules: context.clustering.modules.map((module) => ({
      id: module.id,
      label: context.labels.labels.get(module.id)?.label ?? module.label,
      labelSource: context.labels.labels.get(module.id)?.source ?? 'mechanical',
      directories: module.directories,
      fileCount: module.files.length,
    })),
    moduleEdges: context.clustering.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      importCount: edge.importCount,
    })),
    constraints: intent.constraints,
    intentEmptyReason: intent.emptyReason,
    uncheckable: {
      total: intent.summary.uncheckable,
      byReason: intent.summary.byUncheckableReason,
    },
    completeness: {
      documentsRead: intent.summary.documents,
      documentsFailed: intent.failures.length,
      documentsIncomplete: intent.summary.incompleteDocuments,
      modelUnavailable: intent.degraded,
    },
    violations: violations.violations,
    violationsEmptyReason: violations.emptyReason,
    summary: violations.summary,
    drift: violations.drift,
  };
}

export function renderStaticHtml(context: AnalysisContext, meta: ExportMeta): string {
  const payload = escapeForScript(JSON.stringify(buildExportPayload(context, meta)));
  const commit = meta.commit === null ? 'not a git repository' : meta.commit;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture report — vibe-blueprint</title>
<style>
:root {
  --bg: #ffffff; --fg: #1b1d21; --muted: #5c6270; --line: #e3e6eb;
  --derived: #2f6f4f; --derived-bg: #eaf5ee;
  --stated: #7a4fa3; --stated-bg: #f3ecfa;
  --high: #a3312a; --medium: #9a6512; --low: #4a5568;
  --panel: #fbfcfd;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --fg: #e8eaee; --muted: #9aa2b1; --line: #2c3038;
    --derived: #7fd3a4; --derived-bg: #16302282;
    --stated: #cbaaf0; --stated-bg: #2a1f3a82;
    --high: #f2867d; --medium: #e5b45f; --low: #a9b2c1;
    --panel: #1c1f25;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2.25rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); font-size: .85rem; margin-bottom: .35rem; }
.meta code { font-size: .85em; }
.chip {
  display: inline-block; padding: .05rem .4rem; border-radius: 999px;
  font-size: .7rem; font-weight: 600; letter-spacing: .03em; vertical-align: middle;
}
.derived { background: var(--derived-bg); color: var(--derived); }
.stated { background: var(--stated-bg); color: var(--stated); }
.note {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--muted);
  padding: .6rem .8rem; border-radius: 4px; margin: .6rem 0; color: var(--muted);
}
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; }
.card {
  border: 1px solid var(--line); border-radius: 6px; padding: .7rem .85rem;
  margin: .55rem 0; background: var(--panel);
}
.card.stated-card { border-left: 3px solid var(--stated); }
.sev { font-weight: 700; text-transform: uppercase; font-size: .72rem; }
.sev-high { color: var(--high); } .sev-medium { color: var(--medium); } .sev-low { color: var(--low); }
blockquote {
  margin: .4rem 0; padding-left: .7rem; border-left: 2px solid var(--line);
  color: var(--muted); font-style: italic;
}
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.evidence {
  background: var(--bg); border: 1px solid var(--line); border-radius: 4px;
  padding: .4rem .55rem; overflow-x: auto; font-size: .82rem; margin: .3rem 0;
}
.scroll { overflow-x: auto; }
.src { color: var(--muted); font-size: .8rem; }
</style>
</head>
<body>
<main>
  <h1>Architecture report</h1>
  <div class="meta">
    Generated <strong id="generated"></strong> · commit <code>${escapeHtml(commit)}</code>
  </div>
  <div class="meta">
    <span class="chip derived">DERIVED</span> traced to a real import statement ·
    <span class="chip stated">STATED</span> claimed in prose. They are never merged.
  </div>
  <div id="report"></div>
</main>
<script id="blueprint-data" type="application/json">${payload}</script>
<script>
(function () {
  var el = document.getElementById('blueprint-data');
  var data = JSON.parse(el.textContent || '{}');
  document.getElementById('generated').textContent = data.generatedAt || 'unknown';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var INTENT_EMPTY = {
    'no-documents': 'No README, AGENTS.md, CLAUDE.md or ADRs were found, so there was nothing to read.',
    'not-attempted': 'Documents were found but not read \\u2014 reading prose needs a model and none was available. This is "not attempted", not "nothing stated".',
    'extraction-failed': 'Some documents could not be read to the end, so this list is incomplete. A rule may exist that is simply missing here.',
    'nothing-stated': 'The documents were read and stated no dependency rule checkable against an import graph.'
  };
  var VIOLATION_EMPTY = {
    'no-constraints': 'Nothing to compare: no checkable rule was stated. This zero means "not measured", not "clean".',
    'all-unchecked': 'Rules were stated but none could be evaluated against the graph, so nothing was measured.',
    'all-satisfied': 'Every stated rule was checked against the graph and holds. This zero is a real result.'
  };

  var out = [];

  // ---- derived
  out.push('<h2>Derived structure <span class="chip derived">DERIVED</span></h2>');
  out.push('<p class="meta">' + esc(data.counts.modules) + ' module(s) over ' +
    esc(data.counts.files) + ' file(s) and ' + esc(data.counts.edges) + ' import edge(s).</p>');
  out.push('<div class="scroll"><table><thead><tr><th>Module</th><th class="num">Files</th><th>Directories</th></tr></thead><tbody>');
  (data.modules || []).forEach(function (m) {
    out.push('<tr><td>' + esc(m.label) + ' <span class="src">' + esc(m.id) + '</span></td>' +
      '<td class="num">' + esc(m.fileCount) + '</td><td>' + esc((m.directories || []).join(', ')) + '</td></tr>');
  });
  out.push('</tbody></table></div>');

  // ---- stated
  out.push('<h2>Stated rules <span class="chip stated">STATED</span></h2>');
  var constraints = data.constraints || [];
  if (!constraints.length) {
    out.push('<div class="note">' + esc(INTENT_EMPTY[data.intentEmptyReason] || 'No stated rules.') + '</div>');
  } else {
    constraints.forEach(function (c) {
      var where = c.source.location + (c.source.line == null ? '' : ':' + c.source.line);
      out.push('<div class="card stated-card"><strong>' + esc(c.relation) + '</strong> \\u2014 ' +
        esc(c.subject.phrase) + ' \\u2192 ' + esc(c.object.phrase) +
        (c.via ? ' (via ' + esc(c.via.phrase) + ')' : '') +
        (c.evaluable ? '' : ' <span class="src">(could not be checked)</span>') +
        '<blockquote>' + esc(c.rawText) + '</blockquote>' +
        '<div class="src">' + esc(where) + '</div></div>');
    });
  }
  if (data.uncheckable && data.uncheckable.total > 0) {
    out.push('<div class="note">' + esc(data.uncheckable.total) +
      ' further architectural statement(s) were found that no import graph can decide ' +
      '(style preferences, process rules, runtime behaviour). Counted, not enforced.</div>');
  }
  var comp = data.completeness || {};
  if (comp.documentsFailed > 0 || comp.documentsIncomplete > 0 || comp.modelUnavailable) {
    out.push('<div class="note"><strong>This list is incomplete.</strong> ' +
      esc(comp.documentsFailed) + ' document(s) could not be read and ' +
      esc(comp.documentsIncomplete) + ' were cut off before the end' +
      (comp.modelUnavailable ? ', and no model was available' : '') +
      '. Treat a missing rule as unread, not as absent.</div>');
  }

  // ---- comparison
  out.push('<h2>Where they disagree</h2>');
  out.push('<p class="meta">Drift ' + esc(data.drift.score) + '% \\u2014 ' + esc(data.drift.explanation) + '</p>');
  var violations = data.violations || [];
  if (!violations.length) {
    out.push('<div class="note">' + esc(VIOLATION_EMPTY[data.violationsEmptyReason] || 'No disagreements found.') + '</div>');
  } else {
    violations.forEach(function (v) {
      var html = '<div class="card"><span class="sev sev-' + esc(v.severity) + '">' + esc(v.severity) +
        '</span> \\u2014 ' + esc(v.explanation) +
        '<blockquote>' + esc(v.constraint.rawText) + '</blockquote>' +
        '<div class="src">' + esc(v.constraint.source.location) +
        (v.constraint.source.line == null ? '' : ':' + esc(v.constraint.source.line)) + '</div>';
      (v.edges || []).slice(0, 5).forEach(function (e) {
        (e.evidence || []).slice(0, 2).forEach(function (ev) {
          html += '<pre class="evidence">' + esc(ev.file) + ':' + esc(ev.line) + '  ' + esc(ev.snippet) + '</pre>';
        });
      });
      out.push(html + '</div>');
    });
  }

  document.getElementById('report').innerHTML = out.join('');
})();
</script>
</body>
</html>
`;
}
