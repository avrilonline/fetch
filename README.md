# Fetch Dev Mode

A floating, glass-morphism HTTP client with optional CORS-bypassing local proxy.

## Quick Start

### Without proxy (works for CORS-enabled APIs)

```bash
# Just open the HTML file in your browser
open fetch.html
```

Works out of the box for:
- `https://jsonplaceholder.typicode.com/*`
- `https://httpbin.org/*`
- Your own backend if it sends `Access-Control-Allow-Origin`
- Any public API that allows browser requests

### With proxy (works for everything)

Requires Node.js 14+ (no dependencies, uses only built-in modules).

```bash
# Terminal 1 — start the proxy
node proxy-server.js

# You'll see:
# ┌─────────────────────────────────────────────────┐
# │  ● Fetch Dev Proxy running                      │
# │    http://localhost:3001                        │
# └─────────────────────────────────────────────────┘
```

Then in `fetch.html`:
1. Click the shield icon in the topbar
2. Toggle "Route through proxy" on
3. The shield will turn green when connected
4. Send requests to any URL — CORS no longer applies

## How the proxy works

Your browser hits `localhost:3001/proxy?url=<target>`. The Node server forwards the request server-to-server (no CORS in that direction), then returns the response with permissive CORS headers attached. All headers, query params, and body content are forwarded transparently.

## Security notes

- The proxy **blocks private IP ranges by default** (localhost, 10.x, 192.168.x, etc.) to prevent SSRF attacks against your local network. Override with `ALLOW_PRIVATE=1 node proxy-server.js` if you need to hit your own dev servers.
- The proxy listens only on localhost — no external network exposure.
- Don't expose this proxy publicly. It's a development tool.

## Customization

```bash
# Different port
PORT=8080 node proxy-server.js

# Allow private/local addresses
ALLOW_PRIVATE=1 node proxy-server.js

# Both
PORT=8080 ALLOW_PRIVATE=1 node proxy-server.js
```

## Keyboard shortcuts

- `⌘/Ctrl + Enter` — send request
- `Escape` — close history panel
- Click any JSON `▼` to collapse/expand nodes
