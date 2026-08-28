import type {
  Constraint,
  ResolvedSubject,
  UncheckedConstraint,
  Violation,
} from './verification-types';
import type { VerificationInput } from './verification-outcome';

/**
 * Mock data for all three outcomes plus both zero-violation cases, so every
 * path in VerificationResultPanel is demonstrable with no backend — same
 * "no backend yet, mock data, labeled as such" discipline as
 * layout-presets.ts. Nothing here is real: no actual code was generated, no
 * actual graph was analysed. `VerificationDemo.tsx` shows an on-screen
 * banner saying so, same as `LayoutPresetPanel.tsx` does for its presets.
 */

let mockConstraintCounter = 0;

function resolved(phrase: string, target: string): ResolvedSubject {
  return { phrase, status: 'MODULE', target, reason: null, similarity: 1, alternatives: [] };
}

function mockConstraint(overrides: {
  relation: Constraint['relation'];
  subject: ResolvedSubject;
  object: ResolvedSubject;
  rawText: string;
  location: string;
  confidence?: number;
}): Constraint {
  mockConstraintCounter += 1;
  return {
    id: `mock-constraint-${mockConstraintCounter}`,
    relation: overrides.relation,
    subject: overrides.subject,
    object: overrides.object,
    via: null,
    source: {
      type: 'agents-md',
      location: overrides.location,
      line: 1,
      timestamp: null,
    },
    confidence: overrides.confidence ?? 0.9,
    lowConfidence: (overrides.confidence ?? 0.9) < 0.6,
    rawText: overrides.rawText,
    provenance: 'STATED',
  };
}

// --- Scenario 1: VERIFIED ------------------------------------------------

const VERIFIED_CODE = `// apps/web/src/features/checkout/CheckoutSummary.tsx
import { useCartStore } from '../../state/cartStore';
import { formatCurrency } from '../../lib/format';

export function CheckoutSummary(): JSX.Element {
  const items = useCartStore((state) => state.items);
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <section>
      <h2>Order summary</h2>
      <p>{formatCurrency(total)}</p>
    </section>
  );
}`;

const verifiedConstraint1 = mockConstraint({
  relation: 'must-not-import',
  subject: resolved('checkout feature', 'module-checkout'),
  object: resolved('payments connector', 'module-payments-connector'),
  rawText: 'The checkout feature must not import the payments connector directly.',
  location: 'AGENTS.md',
});

const verifiedConstraint2 = mockConstraint({
  relation: 'must-not-import',
  subject: resolved('ui components', 'module-ui'),
  object: resolved('server-only modules', 'module-server'),
  rawText: 'UI components must not import server-only modules.',
  location: 'AGENTS.md',
});

export const VERIFIED_MOCK: { code: string; input: VerificationInput } = {
  code: VERIFIED_CODE,
  input: {
    constraints: [verifiedConstraint1, verifiedConstraint2],
    conformance: {
      violations: [],
      unchecked: [],
      summary: {
        constraints: 2,
        checked: 2,
        unchecked: 0,
        violated: 0,
        satisfied: 2,
        violations: 0,
        bySeverity: { high: 0, medium: 0, low: 0 },
        byKind: {
          'forbidden-import': 0,
          'bypassed-route': 0,
          cycle: 0,
          'upward-dependency': 0,
        },
        byUncheckedReason: { 'unresolved-role': 0, 'empty-target': 0 },
        implicatedEdges: 0,
      },
    },
  },
};

// --- Scenario 2: VIOLATION DETECTED --------------------------------------

const VIOLATED_CODE = `// apps/web/src/features/checkout/CheckoutSummary.tsx
import { useCartStore } from '../../state/cartStore';
import { chargeCard } from '../../../packages/connectors/payments/stripe';

export function CheckoutSummary(): JSX.Element {
  const items = useCartStore((state) => state.items);

  const handlePay = () => {
    chargeCard(items);
  };

  return (
    <section>
      <button onClick={handlePay}>Pay now</button>
    </section>
  );
}`;

const violatedConstraint = mockConstraint({
  relation: 'must-not-import',
  subject: resolved('checkout feature', 'module-checkout'),
  object: resolved('payments connector', 'module-payments-connector'),
  rawText: 'The checkout feature must not import the payments connector directly.',
  location: 'AGENTS.md',
});

const mockViolation: Violation = {
  id: 'mock-violation-1',
  constraintId: violatedConstraint.id,
  kind: 'forbidden-import',
  severity: 'high',
  severityScore: 0.87,
  severityFactors: ['high confidence rule', 'direct import, not transitive'],
  edges: [
    {
      edgeId: 'mock-edge-1',
      fromModule: 'module-checkout',
      toModule: 'module-payments-connector',
      fromFile: 'apps/web/src/features/checkout/CheckoutSummary.tsx',
      toFile: 'packages/connectors/payments/stripe.ts',
      importCount: 1,
      evidence: [
        {
          file: 'apps/web/src/features/checkout/CheckoutSummary.tsx',
          line: 3,
          snippet: "import { chargeCard } from '../../../packages/connectors/payments/stripe';",
        },
      ],
    },
  ],
  cycle: [],
  explanation:
    'CheckoutSummary.tsx imports the payments connector directly. The documentation says the checkout feature must not do that.',
  constraint: violatedConstraint,
};

export const VIOLATED_MOCK: { code: string; input: VerificationInput } = {
  code: VIOLATED_CODE,
  input: {
    constraints: [violatedConstraint],
    conformance: {
      violations: [mockViolation],
      unchecked: [],
      summary: {
        constraints: 1,
        checked: 1,
        unchecked: 0,
        violated: 1,
        satisfied: 0,
        violations: 1,
        bySeverity: { high: 1, medium: 0, low: 0 },
        byKind: {
          'forbidden-import': 1,
          'bypassed-route': 0,
          cycle: 0,
          'upward-dependency': 0,
        },
        byUncheckedReason: { 'unresolved-role': 0, 'empty-target': 0 },
        implicatedEdges: 1,
      },
    },
  },
};

// --- Scenario 3: UNVERIFIABLE — no constraints stated at all -------------

const UNVERIFIABLE_NO_RULES_CODE = `// apps/web/src/features/onboarding/WelcomeCard.tsx
export function WelcomeCard(): JSX.Element {
  return <div>Welcome!</div>;
}`;

export const UNVERIFIABLE_NO_CONSTRAINTS_MOCK: { code: string; input: VerificationInput } = {
  code: UNVERIFIABLE_NO_RULES_CODE,
  input: {
    constraints: [],
    conformance: {
      violations: [],
      unchecked: [],
      summary: {
        constraints: 0,
        checked: 0,
        unchecked: 0,
        violated: 0,
        satisfied: 0,
        violations: 0,
        bySeverity: { high: 0, medium: 0, low: 0 },
        byKind: {
          'forbidden-import': 0,
          'bypassed-route': 0,
          cycle: 0,
          'upward-dependency': 0,
        },
        byUncheckedReason: { 'unresolved-role': 0, 'empty-target': 0 },
        implicatedEdges: 0,
      },
    },
  },
};

// --- Scenario 4: UNVERIFIABLE — rules stated, none resolved --------------

const UNVERIFIABLE_ALL_UNCHECKED_CODE = `// apps/web/src/features/reporting/RevenueChart.tsx
import { fetchRevenue } from '../../lib/api';

export function RevenueChart(): JSX.Element {
  // ...renders a chart from fetchRevenue()
  return <div />;
}`;

const unresolvedConstraint = mockConstraint({
  relation: 'must-not-import',
  subject: resolved('the reporting tier', 'the-reporting-tier'),
  object: resolved('the legacy billing service', 'the-legacy-billing-service'),
  rawText: 'The reporting tier must not import the legacy billing service.',
  location: 'ARCHITECTURE.md',
  confidence: 0.7,
});

const mockUnchecked: UncheckedConstraint = {
  constraintId: unresolvedConstraint.id,
  reason: 'unresolved-role',
  explanation:
    '"the legacy billing service" does not match any module in this codebase — it may describe something that was never built, or was renamed.',
  constraint: unresolvedConstraint,
};

export const UNVERIFIABLE_ALL_UNCHECKED_MOCK: { code: string; input: VerificationInput } = {
  code: UNVERIFIABLE_ALL_UNCHECKED_CODE,
  input: {
    constraints: [unresolvedConstraint],
    conformance: {
      violations: [],
      unchecked: [mockUnchecked],
      summary: {
        constraints: 1,
        checked: 0,
        unchecked: 1,
        violated: 0,
        satisfied: 0,
        violations: 0,
        bySeverity: { high: 0, medium: 0, low: 0 },
        byKind: {
          'forbidden-import': 0,
          'bypassed-route': 0,
          cycle: 0,
          'upward-dependency': 0,
        },
        byUncheckedReason: { 'unresolved-role': 1, 'empty-target': 0 },
        implicatedEdges: 0,
      },
    },
  },
};
