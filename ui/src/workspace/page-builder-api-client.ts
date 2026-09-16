/**
 * Client for the real /api/page-builder surface (src/server/page-builder-api.ts).
 *
 * Plain synchronous fetch, not submit-and-poll like workflow-api-client.ts:
 * `layoutToComponentFile` makes no LLM call and no subprocess call, so the
 * server itself never returns a job to poll for this endpoint - see
 * page-builder-api.ts's own doc comment for why a job queue would be
 * solving a problem this feature does not have.
 */
import type { GeneratedPageFile, PageLayout } from './page-builder-types';

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? fallback;
}

export async function generatePageFile(layout: PageLayout): Promise<GeneratedPageFile> {
  const response = await fetch('/api/page-builder/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `page-builder generate failed: ${response.status}`),
    );
  }
  const body = (await response.json()) as { file: GeneratedPageFile };
  return body.file;
}
