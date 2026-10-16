const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verified } = require('./local-ai/files.cjs');

async function main() {
  const assets = path.join(__dirname, 'vendor', 'local-ai');
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
  for (const model of manifest.models) {
    if (!await verified(path.join(assets, model.adapterFile), { sha256: model.adapterSha256 })) throw new Error(`Invalid adapter: ${model.adapter}`);
    if (!fs.existsSync(path.join(assets, `${model.id}-LICENSE`))) throw new Error('Missing model license');
  }
  if (!fs.existsSync(path.join(assets, 'runtime', 'llama-server.exe'))) throw new Error('Missing local runtime. Run npm run prepare:local.');
  const tarball = path.join(__dirname, 'vendor', 'vibe-blueprint-0.1.0.tgz');
  const packaged = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', windowsHide: true }));
  if (packaged.name !== 'vibe-blueprint') throw new Error('Wrong server package. Run npm run vendor.');
  const pkg = require('./package.json');
  if (pkg.build.directories.output !== `release/${pkg.version}`) throw new Error('Installer output must use its own version directory to preserve earlier installers.');
  console.log(`Verified ${manifest.models.length} adapters, runtime, licenses and server package for desktop ${pkg.version}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
