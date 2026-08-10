import { describe, expect, it } from 'vitest';
import { buildIntentResponse } from './intent-api.js';
import type { AnalysisContext } from './context.js';

/**
 * Why an empty constraint list is empty.
 *
 * This is the third time this project has had to separate an unmeasured zero
 * from a measured one — after the truncation bug and the drift-chart bug — and
 * the reason it keeps recurring is that the two are byte-identical unless
 * something deliberately distinguishes them.
 */
function context(
  overrides: {
    documents?: number;
    degraded?: boolean;
    failures?: number;
    incompleteDocuments?: number;
    constraints?: number;
  } = {},
): AnalysisContext {
  const {
    documents = 1,
    degraded = false,
    failures = 0,
    incompleteDocuments = 0,
    constraints = 0,
  } = overrides;

  return {
    intent: {
      constraints: Array.from({ length: constraints }, (_, index) => ({
        id: `c-${index}`,
        relation: 'must-not-import',
        subject: { phrase: 'a', status: 'MODULE', target: 'm-a', reason: null, similarity: 1 },
        object: { phrase: 'b', status: 'MODULE', target: 'm-b', reason: null, similarity: 1 },
        via: null,
        confidence: 1,
        lowConfidence: false,
        rawText: 'a must not import b',
        source: { type: 'readme', location: 'README.md', line: 1, timestamp: null },
        provenance: 'STATED',
      })),
      uncheckable: [],
      failures: Array.from({ length: failures }, (_, index) => ({
        location: `doc-${index}.md`,
        reason: 'quota exhausted',
      })),
      summary: {
        documents,
        degraded,
        incompleteDocuments,
        uncheckable: 0,
        byUncheckableReason: {},
      },
    },
  } as unknown as AnalysisContext;
}

describe('why the constraint list is empty', () => {
  it('reports nothing at all when constraints were found', () => {
    expect(buildIntentResponse(context({ constraints: 1 })).emptyReason).toBeNull();
  });

  it('says no-documents when there was nothing to read', () => {
    expect(buildIntentResponse(context({ documents: 0 })).emptyReason).toBe('no-documents');
  });

  it('says not-attempted when no model was available', () => {
    expect(buildIntentResponse(context({ degraded: true })).emptyReason).toBe('not-attempted');
  });

  it('says nothing-stated only when every document was actually read', () => {
    expect(buildIntentResponse(context()).emptyReason).toBe('nothing-stated');
  });

  it('says extraction-failed when a document could not be read', () => {
    /**
     * The Week 11 acceptance case. With the daily model quota exhausted this
     * repository's own CLAUDE.md went unread, and the panel reported "the
     * documents were read and stated no dependency rules" about a file that
     * states six numbered ones.
     */
    expect(buildIntentResponse(context({ failures: 1 })).emptyReason).toBe('extraction-failed');
  });

  it('says extraction-failed when a document was truncated', () => {
    expect(buildIntentResponse(context({ incompleteDocuments: 1 })).emptyReason).toBe(
      'extraction-failed',
    );
  });

  it('prefers not-attempted over extraction-failed when nothing was tried at all', () => {
    // Degraded is the stronger statement: no document was read, rather than
    // some document failing.
    expect(buildIntentResponse(context({ degraded: true, failures: 1 })).emptyReason).toBe(
      'not-attempted',
    );
  });
});
