# Pearl

A self-hosted web proxy: a page with a URL bar that loads sites through your
own server instead of the browser's direct connection.

Built on [Scramjet](https://github.com/MercuryWorkshop/scramjet) (Mercury
Workshop). Ultraviolet, which most older guides still point at, is deprecated
and no longer maintained — its own repo says so. Scramjet is the successor.

## Why this is not a single HTML file

A proxy cannot be one static `.html`. Three pieces are required, and two of
them cannot live in a static file:

1. **The page** (`public/index.html`) — the URL bar and the iframe.
2. **A service worker** — Scramjet rewrites pages client-side and intercepts
   every request the proxied site makes. That interception *is* a service
   worker, so the site must be served over **HTTPS** (or `localhost`); service
   workers are disabled on plain `http://` origins.
3. **A Wisp server** (`/wisp/`) — the part that actually reaches the internet.
   The browser cannot open raw sockets, so it tunnels TCP over a WebSocket to
   your server, which makes the real outbound connection.

So the browser never talks to the target site. It talks to your server, and
your server's IP is what the target sees.

## Layout

```
server.js           Express + proxy-bootstrap; serves the proxy runtime and /wisp/
public/index.html   the UI
```

`server.js` uses `@mercuryworkshop/proxy-bootstrap`, which downloads a known-
compatible set of Scramjet + controller + transport builds from npm at startup
and serves them itself. That avoids the main failure mode of hand-wiring this
stack: the published default config paths do not match the shipped filenames,
and `scramjet-controller` only works against the 2.x line, while the `latest`
npm tag for `@mercuryworkshop/scramjet` is still 1.1.0. Bootstrap resolves that
pairing for you (currently scramjet 2.0.67-alpha.2 + controller 0.0.14).

Two consequences: the server needs `registry.npmjs.org` reachable **at boot**,
and a writable cache directory (`PROXY_CACHE_DIR`, default `./.proxy-cache`).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

`localhost` counts as a secure origin, so the service worker works without TLS.

## Deploying on Enzonic Deploy

I could not reach `enzonic.com` from the machine I built this on, so the
following is from Enzonic's public product pages, not their docs — **verify the
two requirements below before assuming it works.**

What should be straightforward: Enzonic Deploy is git-based and lists Express
as a supported framework, gives each branch a URL, offers free subdomains on
`enzonic.dev`, and does automatic HTTPS. HTTPS is non-negotiable here, so that
part is a good fit.

Settings:

| Setting | Value |
| --- | --- |
| Install | `npm install` |
| Build | *(none)* |
| Start | `npm start` |
| Node | 20 or newer |
| Port | read from `PORT`; `server.js` already does |

### The two things that decide whether it works

1. **WebSocket upgrades must reach `/wisp/`.** The proxy does nothing without
   this. If Enzonic Deploy runs apps as serverless functions rather than a
   long-lived process, WebSockets will not work and this cannot run there.
2. **Outbound TCP must be allowed.** Wisp opens real connections to arbitrary
   hosts and ports. Platforms that only permit outbound HTTP through their own
   egress proxy will break TLS inside the tunnel.

Check: deploy, open the site, and watch the browser console. "Ready." with no
errors means the controller booted. If pages then fail with an SSL or connect
error, hop 2 is being blocked.

**If Deploy turns out to be serverless, use Enzonic Cloud instead** — its
catalog includes a generic Node.js runtime where you clone a repo and run a
long-lived process (free tier advertised at 2 GB RAM / 10 GB SSD, 24/7), which
suits a persistent WebSocket server better.

If you put anything in front of this, pass `Upgrade` and `Connection` through
for `/wisp/`, and do not let a CDN cache `/sw.js` — a stale service worker
means a stale proxy for everyone.

## Things worth knowing before you point people at it

- **It is an open proxy.** Anyone with the URL browses through your server's IP.
  Whatever they do looks like it came from you, and that IP can get blocklisted.
  If it is not meant to be public, put a login in front of it.
- Private and loopback addresses are blocked by default in Wisp, which is what
  stops visitors from reaching things only your server can see. Leave that off.
- Scramjet 2.x is **alpha**. Expect sites to break; Google and other
  heavily-scripted apps are the usual casualties.
- Hosts generally have terms about proxies, and school and workplace networks
  generally have rules about getting around their filters. Those rules are not
  my call, but they are worth knowing before you hand the link around.
