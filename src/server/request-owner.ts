/**
 * Which browser a request comes from, in hosted mode (hosted.ts): a random id
 * the browser keeps to itself and sends with every request. Sessions and jobs
 * carry the id of the browser that made them, and are invisible to every
 * other one. On a local install there is no owner (null) and everything
 * belongs to the one person using it - the behaviour before hosted mode.
 *
 * AsyncLocalStorage, so a background job started by a request keeps that
 * request's owner for as long as it runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const owners = new AsyncLocalStorage<string>();

export function runAsOwner<T>(owner: string, fn: () => T): T {
  return owners.run(owner, fn);
}

export function requestOwner(): string | null {
  return owners.getStore() ?? null;
}

/** Whether something saved with `owner` may be seen by the current request. */
export function visibleToRequester(owner: string | undefined): boolean {
  const who = requestOwner();
  return who === null || owner === who;
}
