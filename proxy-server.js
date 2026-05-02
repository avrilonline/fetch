#!/usr/bin/env node
/**
 * Fetch Dev Mode — Local CORS Proxy
 * ─────────────────────────────────────────
 * Forwards browser requests to any URL, stripping CORS restrictions.
 * Run with: node proxy-server.js
 * Default port: 3001
 *
 * Usage from frontend:
 *   GET  http://localhost:3001/proxy?url=https://api.example.com/users
 *   POST http://localhost:3001/proxy?url=https://api.example.com/users
 *        (with body, headers, etc — all forwarded)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = '*'; // tighten in production

// Headers that shouldn't be forwarded to upstream
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'origin', 'referer',
]);

// Headers that shouldn't be returned to the browser
const RESPONSE_STRIP = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'content-length',
  'transfer-encoding',
  // Strip framing/policy headers so the dev-tool preview iframe can render the page
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  // Don't pollute the user's localhost cookie jar with upstream session cookies
  'set-cookie',
  'strict-transport-security',
]);

// ── ANSI colors for log output ──
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

function logRequest(method, target, status, ms) {
  const ts = new Date().toISOString().slice(11, 19);
  const statusColor = status >= 500 ? c.red : status >= 400 ? c.yellow : status >= 300 ? c.magenta : c.green;
  const methodColor = { GET: c.green, POST: c.blue, PUT: c.yellow, PATCH: c.magenta, DELETE: c.red }[method] || c.dim;
  console.log(
    `${c.dim}${ts}${c.reset} ` +
    `${methodColor}${method.padEnd(6)}${c.reset} ` +
    `${statusColor}${String(status).padEnd(3)}${c.reset} ` +
    `${c.dim}${ms}ms${c.reset}  ${target}`
  );
}

const server = http.createServer((req, res) => {
  // ── CORS PREFLIGHT ──
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── HEALTH CHECK ──
  if (req.url === '/' || req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      service: 'fetch-dev-proxy',
      port: PORT,
      uptime: process.uptime(),
    }));
    return;
  }

  // ── PROXY ROUTE ──
  const proxyUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (proxyUrl.pathname !== '/proxy') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found. Use /proxy?url=<target>' }));
    return;
  }

  const target = proxyUrl.searchParams.get('url');
  if (!target) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid target URL' }));
    return;
  }

  // ── SECURITY: block private/internal addresses by default ──
  // Comment this block out if you intentionally need to proxy to localhost.
  const host = targetUrl.hostname;
  const isPrivate =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host); // link-local

  if (isPrivate && process.env.ALLOW_PRIVATE !== '1') {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Private/internal addresses blocked. Set ALLOW_PRIVATE=1 to permit.',
    }));
    logRequest(req.method, target, 403, 0);
    return;
  }

  // ── BUILD UPSTREAM REQUEST ──
  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      upstreamHeaders[k] = v;
    }
  }
  upstreamHeaders['host'] = targetUrl.host;

  const opts = {
    method: req.method,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    headers: upstreamHeaders,
    timeout: 30_000,
  };

  const t0 = Date.now();
  let responded = false;
  const sendError = (status, payload) => {
    if (responded || res.headersSent) return;
    responded = true;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
    logRequest(req.method, target, status, Date.now() - t0);
  };

  const upstream = lib.request(opts, (upstreamRes) => {
    if (responded) { upstreamRes.resume(); return; }
    responded = true;
    res.statusCode = upstreamRes.statusCode;
    res.statusMessage = upstreamRes.statusMessage;

    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!RESPONSE_STRIP.has(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }

    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS);
    res.setHeader('Access-Control-Expose-Headers', '*');

    upstreamRes.on('error', (err) => {
      try { res.destroy(err); } catch {}
      logRequest(req.method, target, upstreamRes.statusCode || 502, Date.now() - t0);
    });
    upstreamRes.pipe(res);
    upstreamRes.on('end', () => {
      logRequest(req.method, target, upstreamRes.statusCode, Date.now() - t0);
    });
  });

  upstream.on('error', (err) => sendError(502, {
    error: 'Upstream request failed',
    code: err.code,
    message: err.message,
  }));

  upstream.on('timeout', () => {
    upstream.destroy();
    sendError(504, { error: 'Upstream timeout (30s)' });
  });

  req.on('error', () => upstream.destroy());
  req.on('aborted', () => upstream.destroy());

  req.pipe(upstream);
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error(`${c.red}[uncaughtException]${c.reset}`, err.message);
});

server.listen(PORT, () => {
  console.log('');
  console.log(`${c.cyan}┌─────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.green}●${c.reset} Fetch Dev Proxy running                      ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}    ${c.dim}http://localhost:${PORT}${c.reset}                       ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}└─────────────────────────────────────────────────┘${c.reset}`);
  console.log(`${c.dim}  Proxy endpoint:  /proxy?url=<target>${c.reset}`);
  console.log(`${c.dim}  Health check:    /health${c.reset}`);
  console.log(`${c.dim}  Stop with Ctrl+C${c.reset}`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log(`\n${c.dim}Shutting down…${c.reset}`);
  server.close(() => process.exit(0));
});
