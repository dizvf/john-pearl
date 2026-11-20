import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const distOf = (pkg) => dirname(require.resolve(pkg));
const port = process.env.PORT || 3000;

/* ---------------- storage ----------------
 * Accounts and chat need a database; the proxy does not. Storage is loaded
 * after the server is already listening, and in its own try/catch, so that a
 * slow or broken database costs us the chat features and nothing else.
 * Blocking startup on it once took the whole site down, proxy included.
 */
let store = null;
let accountRoutes = null;
let storageStatus = "starting";

/**
 * A short, non-identifying reason a connection failed, safe to serve publicly:
 * the error class only, never the host, the user or the connection string.
 */
function classify(error) {
  const code = error?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  // Order matters: the wrapped message names both TLS attempts, so the
  // specific network and auth failures have to be matched before anything
  // that merely mentions TLS.
  const text = String(error?.message || "").toLowerCase();
  if (text.includes("enotfound")) return "ENOTFOUND";
  if (text.includes("econnrefused")) return "ECONNREFUSED";
  if (text.includes("econnreset")) return "ECONNRESET";
  if (text.includes("etimedout") || text.includes("timeout") || text.includes("timed out")) return "TIMEOUT";
  if (text.includes("password authentication")) return "BAD_PASSWORD";
  if (text.includes("pg_hba")) return "NOT_ALLOWED_FROM_HERE";
  if (text.includes("does not exist")) return "NO_SUCH_DATABASE_OR_ROLE";
  if (text.includes("endpoint")) return "ENDPOINT_NOT_SPECIFIED";
  if (text.includes("certificate") || text.includes("self signed") || text.includes("not support ssl")) {
    return "TLS_PROBLEM";
  }
  return "UNKNOWN";
}

async function openStorage() {
  const [db, auth, chatmod] = await Promise.all([
    import("./lib/db.js"),
    import("./lib/auth.js"),
    import("./lib/chat.js"),
  ]);
  await db.migrate();
  console.log(`database: ${db.backend}`);
  if (!process.env.DATABASE_URL) {
    console.log("warning: no DATABASE_URL, so accounts and messages reset on each deploy");
  }
  return { db, auth, chat: chatmod.createChatServer(), ...chatmod };
}

/* ---------------- wisp ---------------- */
// Visitors can reach any host this tunnel allows. Left open that includes
// things only this server can see -- its own localhost, the host's private
// network, cloud metadata endpoints.
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.stream_limit_per_host = 64;
wisp.options.stream_limit_total = 512;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

const page = (name) => (_req, res) => res.sendFile(join(here, "public", name));

app.get("/", page("index.html"));
app.get("/login", page("login.html"));
app.get("/signup", page("login.html"));
app.get("/chat", page("chat.html"));
app.get("/proxy", page("proxy.html"));
app.get("/healthz", (_req, res) =>
  res.type("text").send(`ok\nstorage=${storageStatus}`)
);

// Resolved at request time, so the routes exist from the first moment and
// simply report themselves unavailable until storage finishes opening.
app.use("/api", (req, res, next) => {
  if (accountRoutes) return accountRoutes(req, res, next);
  res.status(503).json({ error: "Accounts and chat are not available on this server right now." });
});

function buildAccountRoutes({ db, auth, isOnline, pushTo, MAX_BODY }) {
  const {
    attachUser, endSession, hashPassword, normalizeHandle, rateLimit,
    requireUser, startSession, validatePassword, validateUsername, verifyPassword,
  } = auth;

  const app = express.Router();
  app.use(attachUser);

  const publicUser = (u) => ({ id: u.id, username: u.username, handle: u.handle });

  app.get("/me", (req, res) => {
    // `durable` false means this process is holding everything itself, so a
    // second instance or a restart loses it. The UI warns on the strength of
    // this rather than letting people hit mystery sign-outs.
    res.json({ user: req.user ? publicUser(req.user) : null, durable: db.durable });
  });

  app.post("/signup", async (req, res) => {
    const { username, password } = req.body || {};
    const badName = validateUsername(username);
    if (badName) return res.status(400).json({ error: badName });
    const badPass = validatePassword(password);
    if (badPass) return res.status(400).json({ error: badPass });

    // Counted only once the request is otherwise valid, and kept loose on
    // purpose: a whole school behind one NAT shares an IP, so a tight per-IP
    // cap would lock classmates out of signing up at all.
    if (!rateLimit({ key: `signup:${req.ip}`, limit: 20, windowMs: 60 * 60_000 })) {
      return res.status(429).json({ error: "Too many new accounts from this network. Try again later." });
    }

    const handle = normalizeHandle(username);
    if (await db.userByHandle(handle)) {
      return res.status(409).json({ error: "That username is taken." });
    }

    const user = await db.createUser(String(username).trim(), handle, await hashPassword(password));
    await startSession(res, user.id, req.secure);
    res.json({ user: publicUser(user) });
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body || {};
    const handle = normalizeHandle(username);

    if (!rateLimit({ key: `login:${req.ip}:${handle}`, limit: 10, windowMs: 10 * 60_000 })) {
      return res.status(429).json({ error: "Too many attempts. Wait a few minutes." });
    }

    const row = await db.userByHandle(handle);
    // Same reply either way, so this cannot be used to discover who has an account.
    const ok = row && (await verifyPassword(String(password || ""), row.password));
    if (!ok) return res.status(401).json({ error: "Wrong username or password." });

    await startSession(res, row.id, req.secure);
    res.json({ user: publicUser(row) });
  });

  app.post("/logout", async (req, res) => {
    await endSession(req, res);
    res.json({ ok: true });
  });

  /* ---------------- friends ---------------- */

  app.get("/friends", requireUser, async (req, res) => {
    const rows = await db.listFriends(req.user.id);
    res.json({
      friends: rows.map((r) => ({
        id: r.id,
        status: r.status,
        incoming: r.status === "pending" && r.requester_id !== req.user.id,
        user: { id: r.user_id, username: r.username, handle: r.handle },
        online: isOnline(r.user_id),
      })),
    });
  });

  app.post("/friends/request", requireUser, async (req, res) => {
    const handle = normalizeHandle(req.body?.handle);
    if (!handle) return res.status(400).json({ error: "Who do you want to add?" });
    if (handle === req.user.handle) return res.status(400).json({ error: "That is you." });

    const target = await db.userByHandle(handle);
    if (!target) return res.status(404).json({ error: "No one here by that name." });

    const existing = await db.friendshipBetween(req.user.id, target.id);
    if (existing) {
      return res.status(409).json({
        error: existing.status === "accepted" ? "Already friends." : "There is already a request.",
      });
    }

    await db.requestFriend(req.user.id, target.id);
    pushTo([target.id], { type: "friend-request", from: publicUser(req.user) });
    res.json({ ok: true });
  });

  app.post("/friends/:id/accept", requireUser, async (req, res) => {
    const row = await db.acceptFriend(Number(req.params.id), req.user.id);
    if (!row) return res.status(404).json({ error: "No pending request." });
    pushTo([row.requester_id], { type: "friend-accepted", by: publicUser(req.user) });
    res.json({ ok: true });
  });

  app.delete("/friends/:id", requireUser, async (req, res) => {
    const row = await db.removeFriendship(Number(req.params.id), req.user.id);
    if (!row) return res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  });

  /* ---------------- rooms ---------------- */

  async function friendIds(userId) {
    const rows = await db.listFriends(userId);
    return new Set(rows.filter((r) => r.status === "accepted").map((r) => r.user_id));
  }

  app.get("/rooms", requireUser, async (req, res) => {
    const rooms = await db.listRooms(req.user.id);
    const out = [];
    for (const room of rooms) {
      const members = await db.roomMembers(room.id);
      const others = members.filter((m) => m.id !== req.user.id);
      out.push({
        id: room.id,
        kind: room.kind,
        // A DM has no stored name -- it is named after the other person.
        name: room.kind === "dm" ? (others[0]?.username ?? "Empty chat") : room.name,
        members: members.map((m) => ({ id: m.id, username: m.username, handle: m.handle })),
        online: room.kind === "dm" ? isOnline(others[0]?.id) : others.some((m) => isOnline(m.id)),
        lastBody: room.last_body,
        lastAt: room.last_at,
      });
    }
    res.json({ rooms: out });
  });

  app.post("/rooms/dm", requireUser, async (req, res) => {
    const handle = normalizeHandle(req.body?.handle);
    const target = await db.userByHandle(handle);
    if (!target) return res.status(404).json({ error: "No one here by that name." });

    const friendship = await db.friendshipBetween(req.user.id, target.id);
    if (!friendship || friendship.status !== "accepted") {
      return res.status(403).json({ error: "Add them as a friend first." });
    }

    const existing = await db.findDirectRoom(req.user.id, target.id);
    if (existing) return res.json({ roomId: existing.id });

    const room = await db.createRoom(null, "dm", req.user.id);
    await db.addMember(room.id, req.user.id);
    await db.addMember(room.id, target.id);
    pushTo([target.id], { type: "rooms-changed" });
    res.json({ roomId: room.id });
  });

  app.post("/rooms", requireUser, async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (name.length < 1 || name.length > 60) {
      return res.status(400).json({ error: "Give the group a name, up to 60 characters." });
    }

    const handles = Array.isArray(req.body?.handles) ? req.body.handles.slice(0, 50) : [];
    const allowed = await friendIds(req.user.id);

    const room = await db.createRoom(name, "group", req.user.id);
    await db.addMember(room.id, req.user.id);

    const added = [];
    for (const raw of handles) {
      const target = await db.userByHandle(normalizeHandle(raw));
      // You can only pull your own friends into a group.
      if (target && allowed.has(target.id)) {
        await db.addMember(room.id, target.id);
        added.push(target.id);
      }
    }

    if (added.length) pushTo(added, { type: "rooms-changed" });
    res.json({ roomId: room.id });
  });

  app.post("/rooms/:id/invite", requireUser, async (req, res) => {
    const roomId = Number(req.params.id);
    if (!(await db.isMember(roomId, req.user.id))) {
      return res.status(403).json({ error: "You are not in that room." });
    }
    const target = await db.userByHandle(normalizeHandle(req.body?.handle));
    if (!target) return res.status(404).json({ error: "No one here by that name." });
    const allowed = await friendIds(req.user.id);
    if (!allowed.has(target.id)) return res.status(403).json({ error: "Only friends can be added." });

    await db.addMember(roomId, target.id);
    pushTo([target.id], { type: "rooms-changed" });
    pushTo(await db.roomMemberIds(roomId), { type: "members-changed", roomId });
    res.json({ ok: true });
  });

  app.post("/rooms/:id/leave", requireUser, async (req, res) => {
    const roomId = Number(req.params.id);
    await db.leaveRoom(roomId, req.user.id);
    pushTo(await db.roomMemberIds(roomId), { type: "members-changed", roomId });
    res.json({ ok: true });
  });

  app.get("/rooms/:id/messages", requireUser, async (req, res) => {
    const roomId = Number(req.params.id);
    if (!(await db.isMember(roomId, req.user.id))) {
      return res.status(403).json({ error: "You are not in that room." });
    }
    const rows = await db.roomHistory(roomId);
    res.json({
      messages: rows.map((m) => ({
        id: String(m.id),
        roomId,
        userId: m.user_id,
        username: m.username ?? "deleted user",
        handle: m.handle,
        body: m.body,
        createdAt: m.created_at,
      })),
    });
  });

  app.get("/limits", (_req, res) => res.json({ maxBody: MAX_BODY }));

  return app;
}

/* ---------------- proxy runtime ---------------- */

app.use("/scram", express.static(scramjetPath));
app.use("/scram", express.static(distOf("@mercuryworkshop/scramjet-utils")));
app.use("/controller", express.static(distOf("@mercuryworkshop/scramjet-controller")));
app.get("/clients/libcurl-client.js", (_req, res) =>
  res.sendFile(require.resolve("@mercuryworkshop/libcurl-transport"))
);

// The service worker must come from the root so its scope covers /~/sj/, and
// must never be cached -- a stale worker is a stale proxy for every visitor.
app.use(
  express.static(join(here, "public"), {
    setHeaders(res, path) {
      if (path.endsWith("sw.js")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Service-Worker-Allowed", "/");
      }
    },
  })
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Something broke on the server." });
});

/* ---------------- upgrades ---------------- */

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) return wisp.routeRequest(req, socket, head);
  if (req.url.startsWith("/ws") && store) return void store.chat.handleUpgrade(req, socket, head);
  socket.destroy();
});

server.listen(port, () => console.log(`listening on :${port}`));

// Only now, with the proxy already serving, do we go and find a database.
// A database created moments ago may still be coming up, so keep trying for a
// while rather than needing a redeploy to pick it up.
(async () => {
  const waits = [0, 3_000, 8_000, 20_000, 45_000, 90_000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise((r) => setTimeout(r, waits[attempt]));
    try {
      const opened = await openStorage();
      store = opened;
      accountRoutes = buildAccountRoutes(opened);
      storageStatus = `ready:${opened.db.backend}`;
      console.log("accounts and chat are ready");
      return;
    } catch (error) {
      const last = attempt === waits.length - 1;
      storageStatus = `${last ? "failed" : "retrying"}:${classify(error)}`;
      console.error(
        `storage attempt ${attempt + 1}/${waits.length} failed: ${error?.message || error}` +
        (last ? "" : " — retrying")
      );
      if (last) {
        console.error("accounts and chat stay unavailable; the proxy is unaffected");
        console.error(error?.stack || "");
      }
    }
  }
})();
