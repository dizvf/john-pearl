import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { createSession, dropSession, sessionUser } from "./db.js";

const scrypt = promisify(scryptCb);
const KEYLEN = 64;
const COOKIE = "pearl_session";

/* ---------------- passwords ---------------- */

export async function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(plain, salt, KEYLEN);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(plain, stored) {
  const [scheme, salt, hex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = await scrypt(plain, salt, expected.length);
  // Constant time: a length mismatch must not short-circuit differently.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------------- validation ---------------- */

// The handle is the unique, lowercase, mention-safe key. The username is what
// gets displayed and may differ only in case.
export function normalizeHandle(name) {
  return String(name || "").trim().toLowerCase();
}

export function validateUsername(name) {
  const value = String(name || "").trim();
  if (value.length < 3 || value.length > 20) return "Username must be 3 to 20 characters.";
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) return "Use letters, numbers, dots, dashes or underscores only.";
  return null;
}

export function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 8) return "Password must be at least 8 characters.";
  if (value.length > 200) return "That password is too long.";
  return null;
}

/* ---------------- sessions ---------------- */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionTokenFrom(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

export async function startSession(res, userId, secure) {
  const token = randomBytes(32).toString("base64url");
  await createSession(token, userId);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  return token;
}

export async function endSession(req, res) {
  const token = sessionTokenFrom(req);
  if (token) await dropSession(token);
  res.clearCookie(COOKIE, { path: "/" });
}

export const userFromToken = (token) => (token ? sessionUser(token) : null);

/** Populates req.user when a valid session cookie is present. */
export async function attachUser(req, _res, next) {
  try {
    req.user = await userFromToken(sessionTokenFrom(req));
  } catch {
    req.user = null;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in first." });
  next();
}

/* ---------------- throttling ---------------- */

// Small in-memory limiter. Enough to blunt credential stuffing on one node;
// it resets on deploy and is not shared between nodes.
const attempts = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (now > entry.resetAt) attempts.delete(key);
}, 60_000).unref();
