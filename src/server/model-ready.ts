import { requestProvider } from '../llm/request-provider.js';

/**
 * Whether a model can answer this request: the person's own key
 * (request-provider.ts), or the server's own choice being usable right now.
 * Asked per request, so a key added to .env or chosen in the app later, or
 * brought by a visitor, works without a restart.
 */
export async function modelReady(available: (() => Promise<boolean>) | undefined): Promise<boolean> {
  if (requestProvider() !== undefined) return true;
  return available === undefined ? true : available();
}
