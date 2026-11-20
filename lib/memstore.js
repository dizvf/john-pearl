/**
 * In-process store, used when DATABASE_URL is not set.
 *
 * Plain JavaScript: no native module, no WebAssembly, no disk, nothing that
 * can fail to start on a small container. The trade is that everything lives
 * in this process, so accounts and messages are gone when it restarts and are
 * not shared between nodes. Set DATABASE_URL before anyone relies on the data.
 *
 * It mirrors pgstore.js exactly, including the snake_case row shape, so the
 * rest of the app cannot tell which one it is talking to.
 */

export const label = "in-memory";
export const durable = false;

const users = new Map();        // id -> user
const byHandle = new Map();     // handle -> id
const sessions = new Map();     // token -> userId
const friendships = new Map();  // id -> friendship
const rooms = new Map();        // id -> room
const members = new Map();      // roomId -> Set(userId)
const messages = [];            // append only

const seq = { user: 0, friendship: 0, room: 0, message: 0 };
const now = () => new Date();
const clone = (value) => (value ? { ...value } : null);

export async function migrate() { /* nothing to create */ }

/* ---------------- users ---------------- */

export async function createUser(username, handle, password) {
  const id = ++seq.user;
  const row = { id, username, handle, password, created_at: now() };
  users.set(id, row);
  byHandle.set(handle, id);
  return { id, username, handle };
}

export async function userByHandle(handle) {
  return clone(users.get(byHandle.get(handle)));
}

export async function userById(id) {
  const row = users.get(id);
  return row ? { id: row.id, username: row.username, handle: row.handle } : null;
}

/* ---------------- sessions ---------------- */

export async function createSession(token, userId) {
  sessions.set(token, userId);
}

export async function sessionUser(token) {
  return userById(sessions.get(token));
}

export async function dropSession(token) {
  sessions.delete(token);
}

/* ---------------- friends ---------------- */

export async function requestFriend(fromId, toId) {
  for (const f of friendships.values()) {
    if (f.requester_id === fromId && f.addressee_id === toId) return null;
  }
  const id = ++seq.friendship;
  friendships.set(id, {
    id,
    requester_id: fromId,
    addressee_id: toId,
    status: "pending",
    created_at: now(),
  });
  return { id };
}

export async function friendshipBetween(a, b) {
  for (const f of friendships.values()) {
    const match =
      (f.requester_id === a && f.addressee_id === b) ||
      (f.requester_id === b && f.addressee_id === a);
    if (match) return clone(f);
  }
  return null;
}

export async function acceptFriend(id, addresseeId) {
  const f = friendships.get(id);
  if (!f || f.addressee_id !== addresseeId || f.status !== "pending") return null;
  f.status = "accepted";
  return clone(f);
}

export async function removeFriendship(id, userId) {
  const f = friendships.get(id);
  if (!f || (f.requester_id !== userId && f.addressee_id !== userId)) return null;
  friendships.delete(id);
  return { id };
}

export async function listFriends(userId) {
  const out = [];
  for (const f of friendships.values()) {
    if (f.requester_id !== userId && f.addressee_id !== userId) continue;
    const otherId = f.requester_id === userId ? f.addressee_id : f.requester_id;
    const other = users.get(otherId);
    if (!other) continue;
    out.push({
      id: f.id,
      status: f.status,
      requester_id: f.requester_id,
      user_id: other.id,
      username: other.username,
      handle: other.handle,
    });
  }
  return out.sort((a, b) => a.username.localeCompare(b.username));
}

/* ---------------- rooms ---------------- */

export async function createRoom(name, kind, ownerId) {
  const id = ++seq.room;
  const room = { id, name, kind, owner_id: ownerId, created_at: now() };
  rooms.set(id, room);
  members.set(id, new Set());
  return { id, name, kind, owner_id: ownerId };
}

export async function addMember(roomId, userId) {
  if (!members.has(roomId)) members.set(roomId, new Set());
  members.get(roomId).add(userId);
}

export async function isMember(roomId, userId) {
  return members.get(roomId)?.has(userId) ? { "?column?": 1 } : null;
}

export async function roomMemberIds(roomId) {
  return [...(members.get(roomId) || [])];
}

export async function roomMembers(roomId) {
  return [...(members.get(roomId) || [])]
    .map((id) => users.get(id))
    .filter(Boolean)
    .map((u) => ({ id: u.id, username: u.username, handle: u.handle }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function findDirectRoom(a, b) {
  for (const room of rooms.values()) {
    if (room.kind !== "dm") continue;
    const set = members.get(room.id);
    if (set?.has(a) && set?.has(b)) return { id: room.id };
  }
  return null;
}

const lastMessage = (roomId) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].room_id === roomId) return messages[i];
  }
  return null;
};

export async function listRooms(userId) {
  const mine = [...rooms.values()].filter((r) => members.get(r.id)?.has(userId));
  return mine
    .map((r) => {
      const last = lastMessage(r.id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        owner_id: r.owner_id,
        last_body: last?.body ?? null,
        last_at: last?.created_at ?? null,
      };
    })
    .sort((a, b) => {
      if (a.last_at && b.last_at) return b.last_at - a.last_at;
      if (a.last_at) return -1;          // rooms with messages first
      if (b.last_at) return 1;
      return b.id - a.id;
    });
}

export async function leaveRoom(roomId, userId) {
  members.get(roomId)?.delete(userId);
}

/* ---------------- messages ---------------- */

export async function addMessage(roomId, userId, body) {
  const row = { id: ++seq.message, room_id: roomId, user_id: userId, body, created_at: now() };
  messages.push(row);
  return { ...row };
}

export async function roomHistory(roomId, limit = 80) {
  return messages
    .filter((m) => m.room_id === roomId)
    .slice(-limit)
    .map((m) => {
      const u = users.get(m.user_id);
      return {
        id: m.id,
        user_id: m.user_id,
        body: m.body,
        created_at: m.created_at,
        username: u?.username ?? null,
        handle: u?.handle ?? null,
      };
    });
}
