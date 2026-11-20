/**
 * Picks a backend and forwards to it.
 *
 *   DATABASE_URL set -> pgstore.js, real Postgres. Survives deploys, shared
 *                       between nodes. Use this for anything that matters.
 *   not set          -> memstore.js, plain objects in this process. Starts
 *                       anywhere, but the data is gone on restart.
 *
 * Both expose the same functions and the same row shapes, so nothing above
 * this file knows which is in use.
 */

const impl = process.env.DATABASE_URL
  ? await import("./pgstore.js")
  : await import("./memstore.js");

export const backend = impl.label;
export const durable = impl.durable;

export const migrate = () => impl.migrate();

export const createUser = (username, handle, password) => impl.createUser(username, handle, password);
export const userByHandle = (handle) => impl.userByHandle(handle);
export const userById = (id) => impl.userById(id);

export const createSession = (token, userId) => impl.createSession(token, userId);
export const sessionUser = (token) => impl.sessionUser(token);
export const dropSession = (token) => impl.dropSession(token);

export const requestFriend = (fromId, toId) => impl.requestFriend(fromId, toId);
export const friendshipBetween = (a, b) => impl.friendshipBetween(a, b);
export const acceptFriend = (id, addresseeId) => impl.acceptFriend(id, addresseeId);
export const removeFriendship = (id, userId) => impl.removeFriendship(id, userId);
export const listFriends = (userId) => impl.listFriends(userId);

export const createRoom = (name, kind, ownerId) => impl.createRoom(name, kind, ownerId);
export const addMember = (roomId, userId) => impl.addMember(roomId, userId);
export const isMember = (roomId, userId) => impl.isMember(roomId, userId);
export const roomMemberIds = (roomId) => impl.roomMemberIds(roomId);
export const roomMembers = (roomId) => impl.roomMembers(roomId);
export const findDirectRoom = (a, b) => impl.findDirectRoom(a, b);
export const listRooms = (userId) => impl.listRooms(userId);
export const leaveRoom = (roomId, userId) => impl.leaveRoom(roomId, userId);

export const addMessage = (roomId, userId, body) => impl.addMessage(roomId, userId, body);
export const roomHistory = (roomId, limit) => impl.roomHistory(roomId, limit);
