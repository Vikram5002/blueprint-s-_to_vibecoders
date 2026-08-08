// Fixture: TSX. Requires the tsx grammar — the plain typescript grammar cannot
// parse JSX, so this file also proves grammar selection works by extension.
import * as React from 'react';
import { useState } from 'react';
import { Button } from './button';

export interface Props {
  label: string;
}

export function Panel({ label }: Props) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <div className="panel">
      <Button onClick={() => setOpen(!open)}>{label}</Button>
      {open ? <span>{label}</span> : null}
    </div>
  );
}

export default Panel;
