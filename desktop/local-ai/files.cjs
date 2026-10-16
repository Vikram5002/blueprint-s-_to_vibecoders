const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function sha256(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function verified(file, entry, signal) {
  try {
    if (entry.bytes !== undefined && fs.statSync(file).size !== entry.bytes) return false;
    return await sha256(file, signal) === entry.sha256;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Incomplete transfers stay in .part; only a verified file gets its final name.
async function download(entry, folder, { signal, onProgress = () => {}, fetchImpl = fetch } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, entry.name);
  onProgress({ file: entry.name, phase: 'Checking', received: 0, total: entry.bytes });
  if (await verified(target, entry, signal)) return target;
  if (fs.existsSync(target)) throw new Error(`${entry.name} has the wrong checksum. Choose another folder or move that file before retrying.`);
  const partial = target + '.part';
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (offset > entry.bytes) throw new Error(`Invalid partial file: ${partial}`);
  if (offset < entry.bytes) {
    const response = await fetchImpl(entry.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} for ${entry.name}`);
    if (response.status === 206) {
      const range = response.headers.get('content-range');
      if (!range?.startsWith(`bytes ${offset}-`) || !range.endsWith(`/${entry.bytes}`)) throw new Error('Server returned an unexpected download range');
    } else if (response.status === 200) offset = 0;
    else throw new Error(`Unexpected download response: ${response.status}`);
    const handle = await fs.promises.open(partial, offset ? 'a' : 'w');
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        if (offset + chunk.length > entry.bytes) throw new Error('Download exceeded its expected size');
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written);
          if (!result.bytesWritten) throw new Error('Could not write downloaded data');
          written += result.bytesWritten;
        }
        offset += chunk.length;
        onProgress({ file: entry.name, phase: 'Downloading', received: offset, total: entry.bytes });
      }
    } finally { await handle.close(); }
  }
  onProgress({ file: entry.name, phase: 'Verifying', received: offset, total: entry.bytes });
  if (!await verified(partial, entry, signal)) {
    // Only our own failed transfer is removed. Existing user files are never deleted.
    await fs.promises.unlink(partial);
    throw new Error(`Checksum failed for ${entry.name}. Retry to download a fresh copy.`);
  }
  await fs.promises.rename(partial, target);
  return target;
}

module.exports = { sha256, verified, download };
