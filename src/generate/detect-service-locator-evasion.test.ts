import { describe, expect, it } from 'vitest';
import { detectServiceLocatorEvasion } from './detect-service-locator-evasion.js';
import type { GeneratedFile } from './assemble.js';
import type { Constraint, ResolvedSubject } from '../types/constraints.js';

function pathSubject(pattern: string): ResolvedSubject {
  return {
    phrase: pattern,
    status: 'PATH_PATTERN',
    target: `${pattern}/**`,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
}

function pathConstraint(subjectPath: string, objectPath: string): Constraint {
  return {
    id: `${subjectPath}-${objectPath}`,
    relation: 'must-not-import',
    subject: pathSubject(subjectPath),
    object: pathSubject(objectPath),
    via: null,
    source: { type: 'user-authored', location: 'test', line: 1, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: `${subjectPath} must not import ${objectPath}`,
    provenance: 'STATED',
  };
}

const MIDDLEWARE_ROUTES_CONSTRAINT = pathConstraint('backend/src/middleware', 'backend/src/routes');

describe('detectServiceLocatorEvasion', () => {
  it('catches the EXACT known-tension fixture auth-bypass pattern found live (req.app.get(\'findUserById\'))', () => {
    // The real generated code from the live Milestone 3 run documented in
    // docs/GENERATION.md's "Import-graph verification cannot see behavioral
    // workarounds" - reproduced verbatim (trimmed to the relevant lines),
    // not paraphrased.
    const userRouter: GeneratedFile = {
      path: 'backend/src/routes/user-router.ts',
      contents:
        "import { Router } from 'express';\n" +
        'const users: { id: number }[] = [];\n' +
        'export function findUserById(id: number) {\n' +
        '  return users.find((u) => u.id === id);\n' +
        '}\n' +
        'export const router = Router();\n',
    };
    const authMiddleware: GeneratedFile = {
      path: 'backend/src/middleware/auth-middleware.ts',
      contents:
        "import { Request, Response, NextFunction } from 'express';\n" +
        'export function middleware(req: Request, res: Response, next: NextFunction): void {\n' +
        "  const findUserById = req.app.get('findUserById');\n" +
        "  if (typeof findUserById === 'function' && findUserById(req.headers['x-user-id'])) {\n" +
        '    next();\n' +
        '    return;\n' +
        '  }\n' +
        '  res.status(401).end();\n' +
        '}\n',
    };

    const findings = detectServiceLocatorEvasion([userRouter, authMiddleware], [MIDDLEWARE_ROUTES_CONSTRAINT]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'backend/src/middleware/auth-middleware.ts',
      lookupKey: 'findUserById',
      matchedExportFile: 'backend/src/routes/user-router.ts',
    });
    expect(findings[0]?.snippet).toContain("req.app.get('findUserById')");
    expect(findings[0]?.constraint.rawText).toBe('backend/src/middleware must not import backend/src/routes');
  });

  it('does NOT fire on ordinary, legitimate app.get()/app.set() config calls (view engine, trust proxy, port)', () => {
    const userRouter: GeneratedFile = {
      path: 'backend/src/routes/user-router.ts',
      contents: "export function findUserById(id: number) { return null; }\nexport const router = {};\n",
    };
    // A real, common Express configuration idiom - none of these keys name
    // anything user-router.ts actually exports, so none should match.
    const configHeavyMiddleware: GeneratedFile = {
      path: 'backend/src/middleware/config-middleware.ts',
      contents:
        "app.set('view engine', 'ejs');\n" +
        "app.set('trust proxy', 1);\n" +
        "const port = app.get('port');\n" +
        "cache.set('lastRequestAt', Date.now());\n",
    };

    const findings = detectServiceLocatorEvasion([userRouter, configHeavyMiddleware], [MIDDLEWARE_ROUTES_CONSTRAINT]);

    expect(findings).toEqual([]);
  });

  it('does not fire when no constraint forbids the subject file from the object directory', () => {
    const userRouter: GeneratedFile = {
      path: 'backend/src/routes/user-router.ts',
      contents: 'export function findUserById(id: number) { return null; }\n',
    };
    const otherMiddleware: GeneratedFile = {
      path: 'backend/src/middleware/other-middleware.ts',
      contents: "const findUserById = req.app.get('findUserById');\n",
    };

    // No constraints at all - nothing to evade.
    expect(detectServiceLocatorEvasion([userRouter, otherMiddleware], [])).toEqual([]);
  });

  it('does not fire when the lookup key does not match any real export of the forbidden file', () => {
    const userRouter: GeneratedFile = {
      path: 'backend/src/routes/user-router.ts',
      contents: 'export function findUserById(id: number) { return null; }\n',
    };
    const authMiddleware: GeneratedFile = {
      path: 'backend/src/middleware/auth-middleware.ts',
      contents: "const somethingElse = req.app.get('somethingElse');\n",
    };

    expect(detectServiceLocatorEvasion([userRouter, authMiddleware], [MIDDLEWARE_ROUTES_CONSTRAINT])).toEqual([]);
  });

  it('ignores relations other than must-not-import', () => {
    const layerConstraint: Constraint = {
      ...MIDDLEWARE_ROUTES_CONSTRAINT,
      relation: 'must-be-layer-above',
      rawText: 'backend/src/middleware sits above backend/src/routes',
    };
    const userRouter: GeneratedFile = {
      path: 'backend/src/routes/user-router.ts',
      contents: 'export function findUserById(id: number) { return null; }\n',
    };
    const authMiddleware: GeneratedFile = {
      path: 'backend/src/middleware/auth-middleware.ts',
      contents: "const findUserById = req.app.get('findUserById');\n",
    };

    expect(detectServiceLocatorEvasion([userRouter, authMiddleware], [layerConstraint])).toEqual([]);
  });
});
