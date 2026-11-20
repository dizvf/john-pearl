import { WebSocketServer } from "ws";

import { addMessage, isMember, roomMemberIds } from "./db.js";
import { sessionTokenFrom, userFromToken } from "./auth.js";

export const MAX_BODY = 2000;

/**
 * Sockets grouped by user id. One person can have several tabs open, so each
 * user maps to a set rather than a single socket.
 */
const live = new Map();

function track(userId, ws) {
  if (!live.has(userId)) live.set(userId, new Set());
  live.get(userId).add(ws);
}

function untrack(userId, ws) {
  const set = live.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) live.delete(userId);
}

export const isOnline = (userId) => live.has(userId);
export const onlineIds = () => [...live.keys()];

/** Deliver to every open socket of every listed user. */
export function pushTo(userIds, payload) {
  const text = JSON.stringify(payload);
  for (const id of userIds) {
    const sockets = live.get(id);
    if (!sockets) continue;
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }
}

function broadcastPresence(userId, online) {
  const audience = [...live.keys()].filter((id) => id !== userId);
  if (audience.length) pushTo(audience, { type: "presence", userId, online });
}

export function createChatServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, _req, user) => {
    ws.user = user;
    ws.isAlive = true;
    track(user.id, ws);
    broadcastPresence(user.id, true);

    ws.send(JSON.stringify({ type: "hello", user, online: onlineIds() }));

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "send") {
        const roomId = Number(msg.roomId);
        const body = String(msg.body ?? "").trim();
        if (!Number.isInteger(roomId) || !body) return;
        if (body.length > MAX_BODY) {
          return ws.send(JSON.stringify({ type: "error", error: "Message too long." }));
        }
        // Never trust the client's claim of membership.
        if (!(await isMember(roomId, user.id))) {
          return ws.send(JSON.stringify({ type: "error", error: "Not in that room." }));
        }
        const row = await addMessage(roomId, user.id, body);
        pushTo(await roomMemberIds(roomId), {
          type: "message",
          message: {
            id: String(row.id),
            roomId,
            userId: user.id,
            username: user.username,
            handle: user.handle,
            body: row.body,
            createdAt: row.created_at,
          },
        });
        return;
      }

      if (msg.type === "typing") {
        const roomId = Number(msg.roomId);
        if (!Number.isInteger(roomId)) return;
        if (!(await isMember(roomId, user.id))) return;
        const others = (await roomMemberIds(roomId)).filter((id) => id !== user.id);
        pushTo(others, { type: "typing", roomId, userId: user.id, username: user.username });
      }
    });

    ws.on("close", () => {
      untrack(user.id, ws);
      if (!isOnline(user.id)) broadcastPresence(user.id, false);
    });
  });

  // Drop sockets that stopped answering, so presence does not go stale.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  sweep.unref();

  /** Called from the server's single 'upgrade' handler. */
  async function handleUpgrade(req, socket, head) {
    let user = null;
    try {
      user = await userFromToken(sessionTokenFrom(req));
    } catch {
      user = null;
    }
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, user));
  }

  return { wss, handleUpgrade };
}
