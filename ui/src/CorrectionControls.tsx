import { useState } from 'react';
import type { ModuleDetailResponse, ModuleNodeSummary } from './api-types';
import type { NewCorrectionRequest } from './api';

export interface CorrectionControlsProps {
  module: ModuleDetailResponse;
  /** Other modules, for choosing merge targets. */
  allModules: readonly ModuleNodeSummary[];
  onSave: (request: NewCorrectionRequest) => void;
  busy: boolean;
}

type Mode = null | 'rename' | 'merge' | 'split';

/**
 * Rename, merge and split.
 *
 * Split asks for an explicit file list rather than a rule, because the store
 * keeps explicit lists: a file that later appears in the module and is on
 * neither list has no correct answer, and the tool says so instead of guessing.
 * Making the user tick the files is what makes that honest — there was never a
 * rule to re-evaluate.
 */
export function CorrectionControls({
  module,
  allModules,
  onSave,
  busy,
}: CorrectionControlsProps): JSX.Element {
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState('');
  const [mergeWith, setMergeWith] = useState<string[]>([]);
  const [leftName, setLeftName] = useState('');
  const [rightName, setRightName] = useState('');
  const [leftFiles, setLeftFiles] = useState<string[]>([]);

  const reset = (): void => {
    setMode(null);
    setName('');
    setMergeWith([]);
    setLeftName('');
    setRightName('');
    setLeftFiles([]);
  };

  const rightFiles = module.files.map((file) => file.path).filter((path) => !leftFiles.includes(path));

  return (
    <div className="corrections">
      <h3>Correct this module</h3>

      {mode === null && (
        <div className="toolbar">
          <button type="button" className="control" onClick={() => setMode('rename')}>
            rename
          </button>
          <button
            type="button"
            className="control"
            onClick={() => setMode('merge')}
            disabled={allModules.length < 2}
          >
            merge
          </button>
          <button
            type="button"
            className="control"
            onClick={() => setMode('split')}
            disabled={module.files.length < 2}
          >
            split
          </button>
        </div>
      )}

      {mode === 'rename' && (
        <div className="form">
          <label htmlFor="rename-input">New name for this module</label>
          <input
            id="rename-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Import Resolution"
            maxLength={48}
          />
          <Actions
            onCancel={reset}
            onConfirm={() => {
              onSave({ kind: 'rename', moduleIds: [module.id], label: name.trim() });
              reset();
            }}
            disabled={busy || name.trim() === ''}
          />
        </div>
      )}

      {mode === 'merge' && (
        <div className="form">
          <label>Merge this module with</label>
          <div className="checklist">
            {allModules
              .filter((candidate) => candidate.id !== module.id)
              .map((candidate) => (
                <label key={candidate.id} className="check">
                  <input
                    type="checkbox"
                    checked={mergeWith.includes(candidate.id)}
                    onChange={(event) =>
                      setMergeWith((current) =>
                        event.target.checked
                          ? [...current, candidate.id]
                          : current.filter((id) => id !== candidate.id),
                      )
                    }
                  />
                  <span className="mono">{candidate.label}</span>
                  <span className="hint"> ({candidate.fileCount})</span>
                </label>
              ))}
          </div>
          <label htmlFor="merge-name">Name for the merged module</label>
          <input
            id="merge-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
          />
          <Actions
            onCancel={reset}
            onConfirm={() => {
              onSave({
                kind: 'merge',
                moduleIds: [module.id, ...mergeWith],
                label: name.trim(),
              });
              reset();
            }}
            disabled={busy || mergeWith.length === 0 || name.trim() === ''}
          />
        </div>
      )}

      {mode === 'split' && (
        <div className="form">
          <div className="hint" style={{ marginBottom: 6 }}>
            Tick the files for the first side; the rest go to the second. Files added to this module
            later will belong to neither and will be reported rather than guessed at.
          </div>

          <div className="two-up">
            <input
              value={leftName}
              onChange={(event) => setLeftName(event.target.value)}
              placeholder="first side"
              maxLength={48}
            />
            <input
              value={rightName}
              onChange={(event) => setRightName(event.target.value)}
              placeholder="second side"
              maxLength={48}
            />
          </div>

          <div className="checklist">
            {module.files.map((file) => (
              <label key={file.path} className="check">
                <input
                  type="checkbox"
                  checked={leftFiles.includes(file.path)}
                  onChange={(event) =>
                    setLeftFiles((current) =>
                      event.target.checked
                        ? [...current, file.path]
                        : current.filter((path) => path !== file.path),
                    )
                  }
                />
                <span className="mono">{file.path}</span>
              </label>
            ))}
          </div>

          <div className="hint">
            {leftName || 'first'}: {leftFiles.length} · {rightName || 'second'}: {rightFiles.length}
          </div>

          <Actions
            onCancel={reset}
            onConfirm={() => {
              onSave({
                kind: 'split',
                moduleIds: [module.id],
                sides: [
                  { label: leftName.trim(), files: leftFiles },
                  { label: rightName.trim(), files: rightFiles },
                ],
              });
              reset();
            }}
            disabled={
              busy ||
              leftName.trim() === '' ||
              rightName.trim() === '' ||
              leftFiles.length === 0 ||
              rightFiles.length === 0
            }
          />
        </div>
      )}
    </div>
  );
}

function Actions({
  onCancel,
  onConfirm,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="toolbar" style={{ marginTop: 8 }}>
      <button type="button" className="control primary" onClick={onConfirm} disabled={disabled}>
        save
      </button>
      <button type="button" className="control" onClick={onCancel}>
        cancel
      </button>
      <span className="hint" style={{ fontSize: 10 }}>
        applies on the next run
      </span>
    </div>
  );
}
