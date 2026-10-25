const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const port = Number(process.env.PORT || 5173);

http.createServer((request, response) => {
  const pathname = request.url.split('?')[0];
  if (pathname === '/config.js') {
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`window.API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`);
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`KKAGUNG frontend: http://localhost:${port}`));
