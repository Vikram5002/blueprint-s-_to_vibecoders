function connection(current, previous, url, activate = false) {
  const snapshot = { provider: current.current, codeProvider: current.codeProvider, localBaseUrl: current.localBaseUrl, localCodeBaseUrl: current.localCodeBaseUrl };
  const restore = previous ? { ...previous.restore } : snapshot;
  if (previous && activate) {
    if (current.current !== 'local') restore.provider = current.current;
    if (current.codeProvider !== 'local-code') restore.codeProvider = current.codeProvider;
    if (current.localBaseUrl !== previous.managedUrl) restore.localBaseUrl = current.localBaseUrl;
    if (current.localCodeBaseUrl !== previous.managedUrl) restore.localCodeBaseUrl = current.localCodeBaseUrl;
  }
  return {
    saved: { restore, managedUrl: url },
    body: { localBaseUrl: url, localCodeBaseUrl: url, ...(!previous || activate ? { provider: 'local', codeProvider: 'local-code' } : {}) },
  };
}

function restoration(current, saved) {
  const body = {};
  if (current.localBaseUrl === saved.managedUrl) {
    body.localBaseUrl = saved.restore.localBaseUrl;
    if (current.current === 'local') body.provider = saved.restore.provider;
  }
  if (current.localCodeBaseUrl === saved.managedUrl) {
    body.localCodeBaseUrl = saved.restore.localCodeBaseUrl;
    if (current.codeProvider === 'local-code') body.codeProvider = saved.restore.codeProvider;
  }
  return body;
}

module.exports = { connection, restoration };
