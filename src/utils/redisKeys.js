'use strict';

/**
 * Centralized Redis key factory.
 * All keys are prefixed with 'lms:chat:' to avoid collisions
 * with other Redis users (Laravel cache, sessions, queues).
 *
 * Changing keys here updates everywhere — no scattered magic strings.
 */
const K = {
  // ── Token validation cache ──────────────────────────────────────
  // Stores: JSON { userId, userName, isActive } or "INVALID"
  // TTL: TOKEN_CACHE_TTL (5 min default)
  tokenCache: (hashedToken) => `lms:chat:token:${hashedToken}`,

  // ── Membership cache ───────────────────────────────────────────
  // Stores: JSON { role, isMuted, mutedUntil }  or "NOT_MEMBER"
  // TTL: MEMBERSHIP_CACHE_TTL (10 min default)
  membershipCache: (groupId, userId) => `lms:chat:membership:${groupId}:${userId}`,

  // ── Presence ───────────────────────────────────────────────────
  // HSET: field=socketId, value=JSON { userId, name, role, connectedAt }
  // TTL refreshed on heartbeat
  groupPresence: (groupId) => `lms:chat:presence:group:${groupId}`,

  // SET: userId → JSON { socketIds: [], lastSeen, groups: [] }
  // TTL: PRESENCE_TTL
  userPresence: (userId) => `lms:chat:presence:user:${userId}`,

  // ── Typing indicators ──────────────────────────────────────────
  // HSET: field=userId, value=JSON { name, startedAt }
  // TTL: TYPING_TTL (auto-expire)
  groupTyping: (groupId) => `lms:chat:typing:${groupId}`,

  // ── Rate limiting ──────────────────────────────────────────────
  // INCR key, TTL = window seconds
  rateLimit: (userId, groupId) => `lms:chat:rate:${userId}:${groupId}`,

  // ── User socket index ──────────────────────────────────────────
  // SADD: set of socket IDs for a user (cross-tab / cross-device)
  userSockets: (userId) => `lms:chat:sockets:user:${userId}`,
};

module.exports = K;