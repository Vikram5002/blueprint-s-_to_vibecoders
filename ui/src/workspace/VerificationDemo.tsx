import { useState } from 'react';
import { VerificationResultPanel } from './VerificationResultPanel';
import {
  VERIFIED_MOCK,
  VIOLATED_MOCK,
  UNVERIFIABLE_NO_CONSTRAINTS_MOCK,
  UNVERIFIABLE_ALL_UNCHECKED_MOCK,
} from './verification-mocks';

type Scenario =
  'verified' | 'violated' | 'unverifiable-no-constraints' | 'unverifiable-all-unchecked';

const SCENARIOS: readonly { readonly id: Scenario; readonly label: string }[] = [
  { id: 'verified', label: 'Verified' },
  { id: 'violated', label: 'Violation detected' },
  { id: 'unverifiable-no-constraints', label: 'Unverifiable — no rules stated' },
  { id: 'unverifiable-all-unchecked', label: 'Unverifiable — rules unresolved' },
];

function mockFor(scenario: Scenario) {
  switch (scenario) {
    case 'verified':
      return VERIFIED_MOCK;
    case 'violated':
      return VIOLATED_MOCK;
    case 'unverifiable-no-constraints':
      return UNVERIFIABLE_NO_CONSTRAINTS_MOCK;
    case 'unverifiable-all-unchecked':
      return UNVERIFIABLE_ALL_UNCHECKED_MOCK;
  }
}

/**
 * The verification result display, reached via the "Verification" tab in
 * WorkspaceShell. No backend: a scenario switcher over four hand-built mocks
 * (verification-mocks.ts) that cover all three outcomes plus both
 * zero-violation cases.
 */
export function VerificationDemo(): JSX.Element {
  const [scenario, setScenario] = useState<Scenario>('verified');
  const mock = mockFor(scenario);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 rounded border border-amber-700/50 bg-amber-950/20 p-2 text-xs text-amber-300">
          No backend exists yet. Every scenario below is hand-built mock data against the real{' '}
          <code>ConformanceResult</code> shape (src/types/violations.ts) — nothing here was actually
          generated or analysed.
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {SCENARIOS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setScenario(option.id)}
              data-active={scenario === option.id}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
            >
              {option.label}
            </button>
          ))}
        </div>

        <VerificationResultPanel code={mock.code} input={mock.input} />
      </div>
    </div>
  );
}
