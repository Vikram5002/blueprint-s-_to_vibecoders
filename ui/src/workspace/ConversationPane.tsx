/**
 * Empty today, on purpose — no chat, no streaming, no session data exists
 * behind this yet. Placeholder only; wiring is explicitly out of scope for
 * this pass.
 */
export function ConversationPane(): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <div className="flex flex-1 items-center justify-center text-center text-slate-600">
        <p className="text-sm">No messages yet. The conversation will appear here.</p>
      </div>
    </div>
  );
}
