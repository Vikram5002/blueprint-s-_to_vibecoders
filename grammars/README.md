# Vendored tree-sitter grammars

These `.wasm` files are prebuilt tree-sitter grammars, checked in deliberately.

## Why they are vendored

The published grammar bundles ship every language they support. Taking a
dependency on one would have pulled 17–44 MB of grammars for languages this
project is explicitly forbidden from supporting (see CLAUDE.md, "What NOT to
do"). Only these four are needed, and together they are 3.6 MB.

The alternative package (`tree-sitter-wasms`) was also tested and **fails to
load** with `web-tree-sitter` 0.26 — its grammars are built against an older
tree-sitter ABI.

## Provenance

Extracted from [`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm)
version **0.3.1**, `wasm/` directory, unmodified.

| File | Size | Upstream grammar | Licence |
|---|---|---|---|
| `tree-sitter-typescript.wasm` | 1.35 MB | [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT |
| `tree-sitter-tsx.wasm` | 1.38 MB | [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) (tsx dialect) | MIT |
| `tree-sitter-javascript.wasm` | 0.39 MB | [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | MIT |
| `tree-sitter-python.wasm` | 0.44 MB | [tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT |

`tree-sitter-python.wasm` is vendored now but not used until Week 3.

## Known grammar gaps

This build of the TypeScript grammar does not recognise two pieces of modern
syntax. Both produce a localised `ERROR` node; tree-sitter recovers and the rest
of the file parses normally.

| Syntax | Example | Since |
|---|---|---|
| Variance annotations on type parameters | `interface I<in T> {}` | TS 4.7 |
| A parameter named `using` | `f(uri: Uri, using: boolean)` | TS 5.2 |

Measured impact across 997 real TS/JS files (zod, pyright): **5 files affected,
0.5%**. On every one of them **all imports were still extracted** — verified
against the source. The cost is a small number of `export` records inside the
damaged region. Since Week 3 builds dependency edges from imports, the graph is
unaffected.

`src/parser/extract-ts.test.ts` pins this behaviour with a test, so a future
grammar upgrade will surface the change rather than pass silently.

## Updating

Download the newer `@vscode/tree-sitter-wasm` tarball, copy the four files from
`package/wasm/`, and re-run `npm test`. Check the "Known grammar gaps" table
above — a newer grammar may close those cases.
