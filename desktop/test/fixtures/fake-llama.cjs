const http = require('node:http');
const args = process.argv;
const value = (key) => args[args.indexOf(key) + 1];
http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${value('--api-key')}`) { res.writeHead(401); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') { res.end('{}'); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: raw } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
}).listen(Number(value('--port')), '127.0.0.1');
