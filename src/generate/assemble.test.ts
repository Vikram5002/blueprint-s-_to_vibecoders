import { describe, expect, it } from 'vitest';
import { backendEntryPointFile, componentSlug, componentTargetPath, packageJsonFile, tsconfigFile } from './assemble.js';
import type { Component } from '../types/project-schema.js';

const USER_ROUTER: Component = { id: '1', name: 'UserRouter', purpose: 'x' };
const AUTH_MIDDLEWARE: Component = { id: '2', name: 'AuthMiddleware', purpose: 'y' };

describe('componentSlug', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(componentSlug('UserRouter')).toBe('user-router');
    expect(componentSlug('AuthMiddleware')).toBe('auth-middleware');
  });

  it('strips characters that are not alphanumeric or hyphen', () => {
    expect(componentSlug('User Router!!')).toBe('user-router');
  });
});

describe('componentTargetPath', () => {
  it('places backend components under backend/src/routes', () => {
    expect(componentTargetPath('backend', USER_ROUTER)).toBe('backend/src/routes/user-router.ts');
  });

  it('folds security components into backend/src/middleware', () => {
    expect(componentTargetPath('security', AUTH_MIDDLEWARE)).toBe('backend/src/middleware/auth-middleware.ts');
  });

  it('throws for a domain Milestone 1 has no convention for yet', () => {
    expect(() => componentTargetPath('frontend', USER_ROUTER)).toThrow();
    expect(() => componentTargetPath('database', USER_ROUTER)).toThrow();
  });
});

describe('packageJsonFile / tsconfigFile', () => {
  it('produce valid JSON with the locked stack', () => {
    const pkg = JSON.parse(packageJsonFile().contents);
    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeDefined();

    const tsconfig = JSON.parse(tsconfigFile().contents);
    expect(tsconfig.compilerOptions.module).toBe('commonjs');
  });
});

describe('backendEntryPointFile', () => {
  it('mounts security middleware globally before backend routers, each at /api/<slug>', () => {
    const file = backendEntryPointFile([USER_ROUTER], [AUTH_MIDDLEWARE]);

    expect(file.path).toBe('backend/src/index.ts');
    expect(file.contents).toContain("import authMiddleware from './middleware/auth-middleware';");
    expect(file.contents).toContain("import userRouter from './routes/user-router';");
    expect(file.contents).toContain('app.use(authMiddleware);');
    expect(file.contents).toContain("app.use('/api/user-router', userRouter);");

    const middlewareIndex = file.contents.indexOf('app.use(authMiddleware);');
    const routerIndex = file.contents.indexOf("app.use('/api/user-router'");
    expect(middlewareIndex).toBeGreaterThan(-1);
    expect(routerIndex).toBeGreaterThan(middlewareIndex);
  });

  it('produces no middleware wiring when there are no security components', () => {
    const file = backendEntryPointFile([USER_ROUTER], []);
    expect(file.contents).not.toContain('middleware');
  });
});
