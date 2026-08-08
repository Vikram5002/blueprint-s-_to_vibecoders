// Fixture: `export ... from` re-export forms. Each carries a specifier, so each
// must produce BOTH an import record (it is a dependency) and export records.
export { reexported } from './named-source';
export { original as publicName } from './aliased-source';
export * from './star-source';
export * as aggregated from './namespace-source';
export { type ReexportedType } from './type-source';
