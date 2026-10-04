// End-to-end: a real VS Code (downloaded once into .vscode-test/, separate from
// the user's own), this extension loaded from source, a real VibeCoder server.
//   node test/run.cjs <workspace-folder> <server-url>
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // Set when this runs from a terminal inside VS Code; it would start the test
  // VS Code as plain Node instead of as the editor.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const [workspace, serverUrl] = process.argv.slice(2);
  if (!workspace || !serverUrl) throw new Error('usage: node test/run.cjs <workspace-folder> <server-url>');
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, 'e2e.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { VIBECODER_TEST_SERVER: serverUrl },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
