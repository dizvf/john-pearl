# Pearl

A self-hosted web proxy with accounts and chat. Three parts:

- **`/proxy`** — a URL bar that loads sites through your server instead of the
  browser's direct connection.
- **`/chat`** — accounts, friends, direct messages and group rooms, live over
  a WebSocket.
- **`/`** — the main page tying them together.

Built on [Scramjet](https://github.com/MercuryWorkshop/scramjet) (Mercury
Workshop). Ultraviolet, which most older guides still point at, is deprecated
and no longer maintained — its own repo says so. Scramjet is the successor.

## Why the proxy is not a single HTML file

A proxy cannot be one static `.html`. Three pieces are required, and two of
them cannot live in a static file:

1. **The page** — the URL bar and the iframe.
2. **A service worker** (`public/sw.js`) — Scramjet rewrites pages client-side
   and intercepts every request the proxied site makes. That interception *is*
   a service worker, so the site must be served over **HTTPS** (or
   `localhost`); service workers are disabled on plain `http://` origins.
3. **A Wisp server** (`/wisp/`) — the part that reaches the internet. Browsers
   cannot open raw sockets, so it tunnels TCP over a WebSocket to your server,
   which makes the real outbound connection.

So the browser never talks to the target site. It talks to your server, and
your server's IP is what the target sees.

## Layout

```
server.js            routes, API, and the two WebSocket endpoints
lib/db.js            picks a storage backend and forwards to it
lib/pgstore.js       Postgres schema and queries
lib/memstore.js      the in-process fallback
lib/auth.js          password hashing, sessions, rate limiting
lib/chat.js          the live chat socket hub
public/index.html    main page
public/login.html    sign in / create account
public/chat.html     the chat app
public/proxy.html    the proxy
public/style.css     shared theme
public/scene.svg     the sunset artwork, used as a background by every page
public/sw.js         service worker for the proxy
```

Two WebSocket paths share one upgrade handler: `/wisp/` carries proxy traffic,
`/ws` carries chat. Everything else is ordinary HTTP.

## Storage

`lib/db.js` picks a backend and forwards to it. Both expose the same
functions and the same row shapes:

| `DATABASE_URL` | Backend | Data |
| --- | --- | --- |
| set | real Postgres (`lib/pgstore.js`) | survives deploys, shared across nodes |
| not set | plain objects in process (`lib/memstore.js`) | **gone on every restart** |

**On a host that runs more than one instance, the fallback does not work for
chat at all.** Each instance keeps its own copy, so an account created on one
does not exist on the other, and requests landing on the wrong instance are
signed out. Measured on Enzonic: two sign-ups seconds apart were given user
ids 14 and 1, and the second session was rejected immediately afterwards. The
proxy is unaffected, because it holds no state. `/api/me` reports
`durable: false` in this situation and both pages show a warning.

It runs either way, so you can try it locally before setting anything up. The
fallback is deliberately boring — no native module, no WebAssembly, no disk — because
anything exotic is one more thing that can refuse to start on a small
container. The trade is that it holds everything in one process, so accounts
and messages vanish when it restarts and two nodes would not see the same
data.

**Before anyone relies on it**, create a database (Enzonic Databases has a free
tier on the same account) and put its connection string in Enzonic's
environment variables as `DATABASE_URL`. Nothing else changes. Set
`DATABASE_SSL=off` if your database does not use TLS.

The schema is created automatically at startup.

Storage is opened **after** the server is already listening, and the proxy
does not depend on it. If the database cannot be reached, `/proxy` keeps
working and only the account and chat endpoints report themselves unavailable.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

`localhost` counts as a secure origin, so the service worker works without TLS.

## Hosting

| Setting | Value |
| --- | --- |
| Install command | `npm install` |
| Build command | *(none)* |
| Output directory | *(leave empty)* |
| Start command | `node server.js` (from `package.json`) |
| Node version | 20 or newer |
| Port | taken from `PORT` |

**HTTPS is mandatory** for the proxy — on a plain `http://` domain the service
worker will not register, and the page says so instead of proxying. Chat works
either way but sets a secure session cookie only over HTTPS.

The host must also allow **WebSocket upgrades** and **outbound TCP**. On
Enzonic this happens by itself: because the app listens on a port, the builder
puts it in server mode rather than functions, which the build log states.

If you put anything in front of this, pass `Upgrade` and `Connection` through
for `/wisp/` and `/ws`, and do not let a CDN cache `/sw.js` — a stale service
worker means a stale proxy for everyone.

## Versions are pinned on purpose

Do not run `npm update` on the Scramjet packages. The working combination is
narrow:

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
tag. Installing "the latest version" breaks the proxy.

Two more things that cost time, if you edit `proxy.html`:

- `scramjet.js` defines `window.$scramjet`, and `controller.api.js`
  destructures it *at parse time*. They cannot be parallel `<script>` tags.
- Controller paths are set by mutating `$scramjetController.config`; they are
  not constructor arguments, and the defaults do not match the shipped
  filenames.

## How the chat behaves

- Usernames are 3–20 characters. The lowercase form is the unique handle, so
  `Lance` and `lance` are the same account and you can sign in with either.
- Passwords are hashed with scrypt and a per-user salt. Login compares in
  constant time and gives the same answer for a wrong password as for a
  username that does not exist, so the form cannot be used to discover who has
  an account.
- Friend requests must be accepted before a DM can be opened, and only your own
  friends can be pulled into a group.
- Membership is checked on the server for every read and every message. The
  client's claim about which rooms it is in is never trusted.
- Messages render as text, never as HTML.
- Sessions are httpOnly, `SameSite=Lax` cookies, secure over HTTPS.

Rate limits are per process and in memory, so they reset on deploy and are not
shared between nodes. They are deliberately loose on sign-up because a whole
school behind one NAT shares a single IP.

## What has been tested

Automated, against a running server: 32 API and WebSocket checks (sign-up
validation, duplicate names, wrong passwords, session handling, friend
requests, DM creation, group membership, message delivery and persistence,
oversized messages) and 14 browser checks driving two real sessions at once
(live friend request, live message delivery both ways, markup escaped rather
than rendered, mobile layout, and the proxy still reaching ready).

**Not** verified anywhere: nothing outstanding in the app itself. Behaviour
with `DATABASE_URL` pointed at a real Postgres has not been exercised, since
no database was configured at the time of writing.

## Things worth knowing before you point people at it

- **The proxy is open.** Anyone with the URL browses through your server's IP.
  Whatever they do looks like it came from you, and that IP can get
  blocklisted. Accounts currently gate chat, not the proxy; gating the proxy
  too is a small change.
- Private and loopback addresses are blocked in `server.js`, which stops
  visitors reaching things only your server can see — its own localhost, the
  host's internal network, cloud metadata endpoints. Leave that alone.
- Scramjet 2.x is **alpha**. Expect some heavily-scripted sites to break.
- There is no moderation, no message deletion and no account recovery. If you
  forget a password, the account is gone.
- Hosts generally have terms about proxies, and school and workplace networks
  generally have rules about getting around their filters. Worth knowing before
  you hand the link around.
