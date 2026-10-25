const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const port = Number(process.env.PORT || 5173);
const publicFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]);

http.createServer((request, response) => {
  const pathname = request.url.split('?')[0];
  if (pathname === '/config.js') {
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`window.API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`);
    return;
  }
  const requested = publicFiles.get(pathname);
  const filePath = requested ? path.join(root, requested) : null;
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`KKAGUNG frontend: http://localhost:${port}`));
