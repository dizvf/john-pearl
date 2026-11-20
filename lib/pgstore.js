// Real Postgres, used when DATABASE_URL is set. Data survives deploys and is
// shared between nodes.
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
  max: 8,
  connectionTimeoutMillis: 10_000,
});

export const label = "postgres";
export const durable = true;

const sql = async (text, params) => (await pool.query(text, params)).rows;
const one = async (text, params) => (await sql(text, params))[0] || null;

export async function migrate() {
  await sql(`
    CREATE TABLE IF NOT EXISTS users (
      id         serial PRIMARY KEY,
      username   text NOT NULL,
      handle     text NOT NULL UNIQUE,
      password   text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

  await sql(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      text PRIMARY KEY,
      user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

  // One row per pair. 'requester' sent it, 'addressee' accepts or declines.
  await sql(`
    CREATE TABLE IF NOT EXISTS friendships (
      id           serial PRIMARY KEY,
      requester_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       text NOT NULL DEFAULT 'pending',
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (requester_id, addressee_id)
    )`);

  await sql(`
    CREATE TABLE IF NOT EXISTS rooms (
      id         serial PRIMARY KEY,
      name       text,
      kind       text NOT NULL,
      owner_id   integer REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

  await sql(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id   integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    )`);

  await sql(`
    CREATE TABLE IF NOT EXISTS messages (
      id         bigserial PRIMARY KEY,
      room_id    integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id    integer REFERENCES users(id) ON DELETE SET NULL,
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

  await sql(`CREATE INDEX IF NOT EXISTS messages_room_idx ON messages (room_id, id DESC)`);
  await sql(`CREATE INDEX IF NOT EXISTS members_user_idx ON room_members (user_id)`);
}

/* ---------------- users ---------------- */

export const createUser = (username, handle, password) =>
  one(
    `INSERT INTO users (username, handle, password) VALUES ($1, $2, $3)
     RETURNING id, username, handle`,
    [username, handle, password]
  );

export const userByHandle = (handle) =>
  one(`SELECT * FROM users WHERE handle = $1`, [handle]);

export const userById = (id) =>
  one(`SELECT id, username, handle FROM users WHERE id = $1`, [id]);

/* ---------------- sessions ---------------- */

export const createSession = (token, userId) =>
  sql(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, userId]);

export const sessionUser = (token) =>
  one(
    `SELECT u.id, u.username, u.handle
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );

export const dropSession = (token) =>
  sql(`DELETE FROM sessions WHERE token = $1`, [token]);

/* ---------------- friends ---------------- */

export const requestFriend = (fromId, toId) =>
  one(
    `INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)
     ON CONFLICT (requester_id, addressee_id) DO NOTHING
     RETURNING id`,
    [fromId, toId]
  );

export const friendshipBetween = (a, b) =>
  one(
    `SELECT * FROM friendships
      WHERE (requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1)`,
    [a, b]
  );

export const acceptFriend = (id, addresseeId) =>
  one(
    `UPDATE friendships SET status = 'accepted'
      WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
      RETURNING *`,
    [id, addresseeId]
  );

export const removeFriendship = (id, userId) =>
  one(
    `DELETE FROM friendships
      WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)
      RETURNING id`,
    [id, userId]
  );

export const listFriends = (userId) =>
  sql(
    `SELECT f.id, f.status, f.requester_id,
            u.id AS user_id, u.username, u.handle
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = $1 OR f.addressee_id = $1
      ORDER BY u.username`,
    [userId]
  );

/* ---------------- rooms ---------------- */

export const createRoom = (name, kind, ownerId) =>
  one(
    `INSERT INTO rooms (name, kind, owner_id) VALUES ($1, $2, $3)
     RETURNING id, name, kind, owner_id`,
    [name, kind, ownerId]
  );

export const addMember = (roomId, userId) =>
  sql(
    `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [roomId, userId]
  );

export const isMember = (roomId, userId) =>
  one(`SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);

export const roomMemberIds = async (roomId) =>
  (await sql(`SELECT user_id FROM room_members WHERE room_id = $1`, [roomId]))
    .map((r) => r.user_id);

export const roomMembers = (roomId) =>
  sql(
    `SELECT u.id, u.username, u.handle
       FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
      ORDER BY u.username`,
    [roomId]
  );

/** The 1:1 room for two people, if one already exists. */
export const findDirectRoom = (a, b) =>
  one(
    `SELECT r.id
       FROM rooms r
       JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = $1
       JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = $2
      WHERE r.kind = 'dm'
      LIMIT 1`,
    [a, b]
  );

export const listRooms = (userId) =>
  sql(
    `SELECT r.id, r.name, r.kind, r.owner_id,
            (SELECT body       FROM messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT created_at FROM messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS last_at
       FROM rooms r
       JOIN room_members m ON m.room_id = r.id
      WHERE m.user_id = $1
      ORDER BY last_at DESC NULLS LAST, r.id DESC`,
    [userId]
  );

export const leaveRoom = (roomId, userId) =>
  sql(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);

/* ---------------- messages ---------------- */

export const addMessage = (roomId, userId, body) =>
  one(
    `INSERT INTO messages (room_id, user_id, body) VALUES ($1, $2, $3)
     RETURNING id, room_id, user_id, body, created_at`,
    [roomId, userId, body]
  );

export const roomHistory = async (roomId, limit = 80) => {
  const rows = await sql(
    `SELECT m.id, m.user_id, m.body, m.created_at, u.username, u.handle
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
      ORDER BY m.id DESC
      LIMIT $2`,
    [roomId, limit]
  );
  return rows.reverse();
};
