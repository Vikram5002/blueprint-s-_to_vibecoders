import { useState } from 'react';

/**
 * Text box and submit button only. Deliberately disabled — "not yet wired to
 * anything" per today's scope, and a disabled button says that honestly
 * rather than accepting a click that silently does nothing.
 */
export function PromptBar(): JSX.Element {
  const [value, setValue] = useState('');

  return (
    <form
      className="flex flex-shrink-0 items-end gap-3 border-t border-slate-800 bg-slate-950 px-6 py-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Message..."
        rows={1}
        className="max-h-40 min-w-0 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled
        title="Not wired up yet"
        className="flex-shrink-0 rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Send
      </button>
    </form>
  );
}
