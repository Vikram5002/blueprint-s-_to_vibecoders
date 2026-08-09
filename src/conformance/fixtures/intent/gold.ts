/**
 * Hand-labelled evaluation set: 31 real documents.
 *
 * ## What was labelled
 *
 * Every document in this directory was read, and the **checkable constraints** a
 * careful human reads out of it were recorded below. Checkable means it maps
 * onto one of the four relations — decidable by looking at which file imports
 * which. That set is the gold standard, and precision and recall are computed
 * against it.
 *
 * Uncheckable statements are deliberately *not* enumerated exhaustively. A
 * 52 kB configuration reference contains dozens of style and process
 * statements, and hand-listing all of them would take longer than it is worth
 * while adding nothing: they are not what precision and recall are measured on.
 * The tool's count of them is reported as a finding in its own right, and this
 * file records only whether a document contains any, so a document that should
 * produce nothing at all can be distinguished from one that should produce
 * uncheckable statements but no constraints.
 *
 * ## The headline finding
 *
 * Of 31 real documents from four projects — including two genuine agent
 * instruction files, four CONTRIBUTING guides, an architecture reference and a
 * copilot-instructions.md — **exactly one contains constraints expressible in
 * the four relations**, and it is this project's own CLAUDE.md.
 *
 * That is a result about the world, not about the extractor, and it is the
 * single most important thing found this week. Real project documentation
 * overwhelmingly describes structure rather than constraining it: pyright's
 * internals doc lists what each package holds, its copilot-instructions
 * describes an analysis pipeline, its test policy is entirely process. All of
 * it is architectural. Almost none of it is checkable against an import graph.
 *
 * The consequence for the study is stated plainly in docs/INTENT.md: recall is
 * being measured against a very small positive set, and a per-document recall
 * figure computed from one positive document is not a number to build a
 * conclusion on. Better to know that now than in Week 14.
 */
import type { ConstraintRelation } from '../../../types/constraints.js';

export interface GoldConstraint {
  readonly relation: ConstraintRelation;
  /** The noun phrase the document uses, not a module id. */
  readonly subject: string;
  readonly object: string;
  readonly via?: string;
  /** Why a careful reader records this one. */
  readonly note: string;
}

export interface GoldDocument {
  readonly file: string;
  /** Checkable constraints. The gold standard for precision and recall. */
  readonly constraints: readonly GoldConstraint[];
  /** True when the document says architectural things none of the four cover. */
  readonly hasUncheckableStatements: boolean;
  /** Recorded where the call was genuinely close, so the label can be argued with. */
  readonly judgement?: string;
}

export const GOLD: readonly GoldDocument[] = [
  {
    file: 'blueprint-claude.md',
    constraints: [
      {
        relation: 'must-not-import',
        subject: 'parser/',
        object: 'llm/',
        note: 'Rule 1 names two subjects in one sentence; a reader records one constraint per subject.',
      },
      {
        relation: 'must-not-import',
        subject: 'graph/',
        object: 'llm/',
        note: 'The second subject of rule 1.',
      },
      {
        relation: 'must-not-import',
        subject: 'ui/',
        object: 'src/',
        note: 'Rule 4, stated directly.',
      },
      {
        relation: 'may-only-import-via',
        subject: 'ui/',
        object: 'src/',
        via: 'server/',
        note: 'The sentence after rule 4 gives the permitted route, which is a separate claim from the prohibition.',
      },
    ],
    hasUncheckableStatements: true,
    judgement:
      'Rules 2, 3 and 5 are architectural and non-negotiable but none is a dependency relation — provenance fields, evidence arrays and "no business logic in cli/" cannot be decided from an import graph. Rule 6, "no network calls outside llm/", is runtime behaviour rather than imports. All four are uncheckable, not missed.',
  },

  {
    file: 'blueprint-architecture.md',
    constraints: [],
    hasUncheckableStatements: true,
    judgement:
      'The closest call in the corpus. "The determinism boundary sits between Stage 2 and Stage 3. Everything above it is reproducible" reads like must-be-layer-above, but "above" refers to position in a pipeline diagram, not to modules and not to import direction. A reader who extracted it would be inventing a relation between two things that are not modules. Deliberately labelled as a hard negative.',
  },

  // Two real agent instruction files. Both are entirely process and precision
  // policy: what an agent may change and what justification it must provide.
  { file: 'pyright-test-policy.md', constraints: [], hasUncheckableStatements: true },
  { file: 'pyright-typeshed-agent.md', constraints: [], hasUncheckableStatements: true },

  {
    file: 'pyright-copilot-instructions.md',
    constraints: [],
    hasUncheckableStatements: true,
    judgement:
      'Rich in architecture and yields nothing checkable. "All logic lives here" and the five-phase analysis pipeline describe structure; "all user-facing diagnostic messages come from localization/localize.ts" is a real rule whose subject is a category of value rather than a module, so no relation fits it.',
  },

  { file: 'pyright-internals.md', constraints: [], hasUncheckableStatements: true },
  { file: 'pyright-import-resolution.md', constraints: [], hasUncheckableStatements: true },
  { file: 'pyright-contributing.md', constraints: [], hasUncheckableStatements: true },
  { file: 'pyright-build-debug.md', constraints: [], hasUncheckableStatements: false },
  { file: 'pyright-ci-integration.md', constraints: [], hasUncheckableStatements: false },
  { file: 'pyright-commands.md', constraints: [], hasUncheckableStatements: false },
  { file: 'pyright-getting-started.md', constraints: [], hasUncheckableStatements: false },
  { file: 'pyright-mypy-comparison.md', constraints: [], hasUncheckableStatements: true },
  { file: 'pyright-readme.md', constraints: [], hasUncheckableStatements: false },
  { file: 'pyright-type-concepts.md', constraints: [], hasUncheckableStatements: false },

  {
    file: 'pyright-configuration.md',
    constraints: [],
    hasUncheckableStatements: true,
    judgement:
      'Contains the phrase "cyclical import chains ... generally, they should be avoided", which is the corpus\'s best bait for a false must-not-cycle. It documents a diagnostic option about the *user\'s* code, not a constraint on pyright\'s own architecture, so a careful reader does not record it.',
  },

  { file: 'requests-ai-policy.md', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-contributing.md', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-dev-contributing.rst', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-security.md', constraints: [], hasUncheckableStatements: false },
  { file: 'requests-readme.md', constraints: [], hasUncheckableStatements: false },
  { file: 'requests-faq.rst', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-recommended.rst', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-release-process.rst', constraints: [], hasUncheckableStatements: true },
  { file: 'requests-support.rst', constraints: [], hasUncheckableStatements: false },

  { file: 'zod-contributing.md', constraints: [], hasUncheckableStatements: true },
  { file: 'zod-code-of-conduct.md', constraints: [], hasUncheckableStatements: false },
  { file: 'zod-changelog.md', constraints: [], hasUncheckableStatements: false },
  { file: 'zod-error-handling.md', constraints: [], hasUncheckableStatements: false },
  { file: 'zod-docs-readme.md', constraints: [], hasUncheckableStatements: false },
  {
    file: 'zod-migration.md',
    constraints: [],
    hasUncheckableStatements: true,
    judgement:
      '"Zod no longer supports cyclical data" is about runtime data structures, not import cycles. A plausible false positive for must-not-cycle.',
  },
];

/** Every gold constraint, flattened, for corpus-level scoring. */
export const GOLD_CONSTRAINTS: readonly (GoldConstraint & { readonly file: string })[] = GOLD.flatMap((document) =>
  document.constraints.map((constraint) => ({ ...constraint, file: document.file })),
);
