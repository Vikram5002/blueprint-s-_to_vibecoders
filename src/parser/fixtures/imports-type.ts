// Fixture: TypeScript type-only import forms.
import type { TypeOnly } from './type-only';
import type DefaultType from './default-type';
import type * as TypeNamespace from './type-namespace';
import { type InlineType, valueAlongside } from './mixed-inline';
import legacyRequire = require('./legacy-require');

export type Alias = TypeOnly | DefaultType | InlineType;
export const value = [valueAlongside, legacyRequire, TypeNamespace];
