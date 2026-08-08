import { core } from '@app/core';
import { helper } from '@lib/helpers';
import { exact } from '@exact';
import { thing } from 'utils/thing';
import { nope } from '@app/missing-target';
import express from 'express';
export const app = [core, helper, exact, thing, nope, express];
