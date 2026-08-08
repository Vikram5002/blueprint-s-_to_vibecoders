// Fixture: local export forms. None of these have a specifier, so none of them
// may produce an import record.
export const constant = 1;
export const multipleA = 'a', multipleB = 'b';
export let mutable = 2;
export function fn() {}
export async function asyncFn() {}
export class Cls {}
export abstract class AbstractCls {}
export interface Iface {
  field: string;
}
export type TypeAlias = string;
export enum Enum {
  Member,
}
export declare const ambient: number;

const localA = 3;
const localB = 4;
export { localA, localB as renamedLocal };

const notExported = 5;
void notExported;

export default function defaultExport() {}
