import { describe, expect, it } from 'vitest';
import {
  backendEntryPointFile,
  componentSlug,
  componentTargetPath,
  frontendEntryPointFile,
  packageJsonFile,
  tsconfigFile,
} from './assemble.js';
import type { Component } from '../types/project-schema.js';

const USER_ROUTER: Component = { id: '1', name: 'UserRouter', purpose: 'x' };
const AUTH_MIDDLEWARE: Component = { id: '2', name: 'AuthMiddleware', purpose: 'y' };
const RECIPE_STORE: Component = { id: '3', name: 'RecipeStore', purpose: 'z' };
const RECIPE_LIST_PAGE: Component = { id: '4', name: 'RecipeListPage', purpose: 'w' };

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

  it('folds database components into backend/src/db', () => {
    expect(componentTargetPath('database', RECIPE_STORE)).toBe('backend/src/db/recipe-store.ts');
  });

  it('gives frontend components their own top-level folder, not folded into backend', () => {
    expect(componentTargetPath('frontend', RECIPE_LIST_PAGE)).toBe('frontend/src/pages/recipe-list-page.tsx');
  });
});

describe('packageJsonFile / tsconfigFile', () => {
  it('produce a backend-only manifest by default, unchanged from Milestone 1', () => {
    const pkg = JSON.parse(packageJsonFile().contents);
    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.dependencies.react).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
    expect(pkg.devDependencies['@types/node']).toBe('^20.14.0');
    expect(pkg.engines).toBeUndefined();

    const tsconfig = JSON.parse(tsconfigFile().contents);
    expect(tsconfig.compilerOptions.module).toBe('commonjs');
    expect(tsconfig.compilerOptions.jsx).toBeUndefined();
    expect(tsconfig.include).toEqual(['backend/**/*.ts']);
  });

  it('adds no extra npm dependency for the database domain - node:sqlite is built in', () => {
    const pkg = JSON.parse(packageJsonFile({ database: true }).contents);
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.devDependencies['@types/better-sqlite3']).toBeUndefined();
    // node:sqlite's type declarations need a recent @types/node.
    expect(pkg.devDependencies['@types/node']).toBe('^22.10.0');
    expect(pkg.engines).toEqual({ node: '>=22.5.0' });
  });

  it('adds react + jsx support when the frontend domain is present', () => {
    const pkg = JSON.parse(packageJsonFile({ frontend: true }).contents);
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.dependencies['react-dom']).toBeDefined();

    const tsconfig = JSON.parse(tsconfigFile({ frontend: true }).contents);
    expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
    expect(tsconfig.include).toEqual(['backend/**/*.ts', 'frontend/**/*.tsx']);
  });
});

describe('frontendEntryPointFile', () => {
  it('imports and mounts every frontend component into #root', () => {
    const file = frontendEntryPointFile([RECIPE_LIST_PAGE]);

    expect(file.path).toBe('frontend/src/main.tsx');
    expect(file.contents).toContain("import RecipeListPage from './pages/recipe-list-page';");
    expect(file.contents).toContain('createRoot(container).render(');
    expect(file.contents).toContain('<RecipeListPage />');
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
