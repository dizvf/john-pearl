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
2. **A service worker** (`public/sw.js`) — Scramjet rewrites pages client-side
   and intercepts every request the proxied site makes. That interception *is*
   a service worker, so the site must be served over **HTTPS** (or
   `localhost`); service workers are disabled on plain `http://` origins.
3. **A Wisp server** (`/wisp/`) — the part that actually reaches the internet.
   The browser cannot open raw sockets, so it tunnels TCP over a WebSocket to
   your server, which makes the real outbound connection.

So the browser never talks to the target site. It talks to your server, and
your server's IP is what the target sees.

## Layout

```
server.js           Express: serves the proxy runtime and the /wisp/ tunnel
public/index.html   the UI
public/sw.js        the service worker that intercepts proxied requests
node_modules/       bundled in the zip, so no install step is needed
```

Everything is served from pinned packages in `node_modules`. Nothing is
downloaded at startup, so the server boots with no network access of its own
and cannot break because an upstream package moved.

### Versions are pinned on purpose

Do not run `npm update` on this. The working combination is narrow:

| Package | Version |
| --- | --- |
| `@mercuryworkshop/scramjet` | `2.0.67-alpha.2` |
| `@mercuryworkshop/scramjet-controller` | `0.0.14` |
| `@mercuryworkshop/scramjet-utils` | `0.0.3` |
| `@mercuryworkshop/libcurl-transport` | `2.0.6` |
| `@mercuryworkshop/wisp-js` | `0.5.3` |

The npm `latest` tag for `@mercuryworkshop/scramjet` is **1.1.0**, which is the
*old* line — it prints "please upgrade to v2" on load and does not work with
`scramjet-controller` at all. The 2.x line is alpha and only on the `alpha`
tag. Installing "the latest version" of these packages breaks the proxy.

Two other things that cost me time, in case you edit the page:

- `scramjet.js` is what defines `window.$scramjet`, and `controller.api.js`
  destructures it *at parse time*. They cannot be parallel `<script>` tags;
  they have to be loaded in sequence, which is why `index.html` loads them
  through a `loadScript()` helper.
- Controller paths are set by mutating `$scramjetController.config`. They are
  not constructor arguments, and the library's defaults do not match the
  shipped filenames.

## Run locally

```bash
npm start          # http://localhost:3000
```

`localhost` counts as a secure origin, so the service worker works without TLS.
If you cloned this from git rather than using the zip, run `npm install` first.

## Hosting the zip

The zip is self-contained — unzip it, point the panel at it, and start it.

| Setting | Value |
| --- | --- |
| Start command | `node server.js` |
| Install command | *none needed; `node_modules` is included* |
| Node version | 20 or newer |
| Port | taken from `PORT`, else 3000 |

**HTTPS is mandatory**, not a nice-to-have. On a plain `http://` domain the
service worker will not register and the page will tell you so instead of
proxying anything.

### The two things that decide whether a host can run this

1. **WebSocket upgrades must reach `/wisp/`.** The proxy does nothing without
   this. A host that only runs short-lived serverless functions cannot run it.
2. **Outbound TCP must be allowed.** Wisp opens real connections to arbitrary
   hosts and ports. Hosts that force all outbound traffic through their own
   HTTP proxy will break TLS inside the tunnel.

On Enzonic specifically: I could not reach `enzonic.com` to check, so verify
both. Their **Cloud** Node.js runtime (a long-lived process) is the better bet
than anything function-based, and **Deploy** supplies automatic HTTPS and
`enzonic.dev` subdomains, which requirement above needs.

If you put anything in front of this, pass `Upgrade` and `Connection` through
for `/wisp/`, and do not let a CDN cache `/sw.js` — a stale service worker
means a stale proxy for everyone.

### Checking a deployment

Open the site and watch the browser console.

- Green dot and "Ready." — the service worker registered and the controller
  started. The proxy itself is working.
- Pages fail with an **SSL or connect error** — the page is fine and the host
  is blocking requirement 2 above.
- Status stuck or complaining about secure context — you are on `http://`.

## What has been tested

Verified in headless Chromium: assets serve, the service worker registers, the
controller reaches ready, navigation rewrites to the `/~/sj/...` prefix, and a
page fetched entirely through the Wisp tunnel renders in the iframe with no
console errors.

**Not** verified: fetching a real external HTTPS site. The sandbox this was
built in routes outbound HTTPS through an intercepting proxy, and
libcurl-in-WASM does its own TLS with its own CA store, so external requests
fail there with `SSL connect error` regardless of the code. That hop is the
first thing to check on a real host.

## Things worth knowing before you point people at it

- **It is an open proxy.** Anyone with the URL browses through your server's IP.
  Whatever they do looks like it came from you, and that IP can get blocklisted.
  If it is not meant to be public, put a login in front of it.
- Private and loopback addresses are blocked in `server.js`, which is what
  stops visitors from reaching things only your server can see — its own
  localhost, the host's internal network, cloud metadata endpoints. Leave those
  settings alone.
- Scramjet 2.x is **alpha**. Expect sites to break; heavily-scripted apps like
  Google are the usual casualties.
- Hosts generally have terms about proxies, and school and workplace networks
  generally have rules about getting around their filters. Those rules are not
  my call, but they are worth knowing before you hand the link around.
