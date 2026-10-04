// Runs inside VS Code's extension host. The two questions a person answers
// (what to do, Keep or Discard) are answered by replacing those window
// functions; everything else - the server call, the diff, the edit, the
// save, Undo - is the extension's real code path.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const TARGET = 'src/routes/users.ts';

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a workspace folder is open');
  await vscode.workspace.getConfiguration('vibecoder').update('serverUrl', process.env.VIBECODER_TEST_SERVER, vscode.ConfigurationTarget.Workspace);

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vibecoder');
  assert.ok(ext, 'the extension is installed');
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['vibecoder.reworkFile', 'vibecoder.reworkActiveFile', 'vibecoder.undo', 'vibecoder.clearHistory']) {
    assert.ok(commands.includes(id), `command ${id} is registered`);
  }

  const uri = vscode.Uri.joinPath(folder.uri, TARGET);
  const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  assert.match(original, /from '\.\.\/db\/users-table'/, 'the file starts with the forbidden import');

  // Answer the questions: "Fix the violation(s)", then "Keep"; note what the person was told.
  const asked = [];
  const window = vscode.window;
  window.showQuickPick = async (items) => {
    const list = await items;
    asked.push(`pick: ${list.join(' | ')}`);
    return list[0];
  };
  window.showInformationMessage = async (message, ...rest) => {
    asked.push(`info: ${message}`);
    if (rest.includes('Keep')) return 'Keep';
    return undefined;
  };

  await vscode.commands.executeCommand('vibecoder.reworkFile', uri);

  const kept = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  console.log('[e2e] questions shown:\n  ' + asked.join('\n  '));
  console.log('[e2e] file after Keep:\n' + kept);
  assert.notEqual(kept, original, 'Keep wrote the proposal to disk');
  assert.doesNotMatch(kept, /db\/users-table/, 'the forbidden import is gone');
  assert.ok(asked.some((a) => a.startsWith('pick: Fix the 1 rule violation(s)')), 'the person was offered the fix');
  assert.ok(asked.some((a) => a.includes('violating import(s) are gone')), 'the Keep question reports the check');

  // Undo from the panel's entry: the original text comes back exactly.
  const ok = await vscode.commands.executeCommand('vibecoder.undoLast');
  assert.equal(ok, true, 'there was a kept change to undo');
  const undone = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  assert.equal(undone, original, 'Undo restored the original text');
  console.log('[e2e] PASS: rework -> diff -> Keep -> file changed -> Undo -> original restored');
}

module.exports = { run };
