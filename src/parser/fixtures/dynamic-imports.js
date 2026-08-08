// Fixture: dynamic import() forms.
const awaited = await import('./awaited');

import('./bare-statement');

const thenned = import('./thenned').then((m) => m.default);

async function inside() {
  // Nested inside a function — must still be found.
  const nested = await import('./nested-inside-function');
  return nested;
}

// Non-literal specifier: skipped rather than recorded with a wrong specifier.
const name = './computed-module';
const computed = await import(name);

// Template literal with no substitutions is still a static specifier.
const templated = await import(`./templated`);

export { awaited, thenned, inside, computed, templated };
