// Fixture: every ES import form. Not compiled — see tsconfig `exclude`.
import './side-effect-only';
import defaultOnly from './default-only';
import { named, other } from './named';
import { original as renamed } from './aliased';
import defaultAndNamed, { alsoNamed } from './mixed';
import * as namespace from './namespace';
import defaultAndNamespace, * as bothNamespace from './default-and-namespace';

// A multi-line import: the record must still point at the statement's first line.
import {
  multiLineA,
  multiLineB as multiLineC,
} from './multi-line';

export const usage = [
  defaultOnly,
  named,
  other,
  renamed,
  defaultAndNamed,
  alsoNamed,
  namespace,
  defaultAndNamespace,
  bothNamespace,
  multiLineA,
  multiLineC,
];
