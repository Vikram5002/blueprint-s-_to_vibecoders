import { util } from '@myorg/utils';
import { sub } from '@myorg/utils/src/sub';
import { script } from '@myorg/scripts';
import { exported } from '@myorg/exported';
import { deep } from '@myorg/exported/deep';
import { fr } from '@myorg/exported/locales/fr.js';
import lodash from 'lodash';
export const main = [util, sub, script, exported, deep, fr, lodash];
