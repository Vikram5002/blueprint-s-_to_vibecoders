import { describe, expect, it } from 'vitest';
import { extractIntent } from './intent.js';
import type { ClusteringResult } from '../types/modules.js';
import type { LabelSet } from '../types/labels.js';

// extractIntent only reads the module list from these on the no-model path.
const clustering = { modules: [] } as unknown as ClusteringResult;
const labels = { labels: new Map() } as unknown as LabelSet;

describe('extractIntent without a model', () => {
  it('is not degraded when there is nothing to read: the stated rules are complete, not missing', async () => {
    const result = await extractIntent({ root: '.', clustering, labels, useModel: false, documents: [] });
    expect(result.summary.documents).toBe(0);
    expect(result.summary.degraded).toBe(false);
  });

  it('is degraded when documents went unread for lack of a model', async () => {
    const result = await extractIntent({
      root: '.',
      clustering,
      labels,
      useModel: false,
      documents: [{ type: 'readme', location: 'README.md', timestamp: null, text: 'src/api must not import src/db.', truncated: false }],
    });
    expect(result.summary.documents).toBe(1);
    expect(result.summary.degraded).toBe(true);
  });
});
