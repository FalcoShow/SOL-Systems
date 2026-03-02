'use strict';
console.log('=== MINIMAL TEST: Node started ===');
console.log('Port will be:', process.env.PORT);
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
});
server.listen(process.env.PORT || 3001, () => {
  console.log('=== Server listening on port', process.env.PORT || 3001, '===');
});