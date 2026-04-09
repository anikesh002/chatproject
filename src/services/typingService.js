'use strict';

const { redisClient } = require('../config/redis');
const K              = require('../utils/redisKeys');
const config         = require('../config/env');
const logger         = require('../utils/logger');

/**
 * TypingService
 *
 * Uses Redis HSET with a key TTL to track who is typing in each group.
 *
 * lms:chat:typing:{groupId}
 *   field: userId
 *   value: JSON { name, startedAt }
 *   key TTL: TYPING_TTL (5s by default) — auto-clears stale indicators
 *
 * The key TTL is reset on every typing event, giving a sliding window.
 * If no typing events arrive within TYPING_TTL seconds, the key expires
 * and all typing indicators are automatically cleared.
 */

/**
 * Mark a user as currently typing in a group.
 * Returns the current list of typists (excluding the user themselves, for broadcast).
 */
async function startTyping(groupId, userId, name) {
  const key  = K.groupTyping(groupId);
  const ttl  = config.TTL.typing;

  try {
    const entry = JSON.stringify({ name, startedAt: new Date().toISOString() });
    await redisClient
      .pipeline()
      .hset(key, String(userId), entry)
      .expire(key, ttl * 2) // 2x typing TTL on key; individual fields tracked below
      .exec();

    return await getTypingUsers(groupId, userId);
  } catch (e) {
    logger.warn('Typing: startTyping error', { message: e.message });
    return [];
  }
}

/**
 * Mark a user as stopped typing.
 * Returns updated list of typists.
 */
async function stopTyping(groupId, userId) {
  const key = K.groupTyping(groupId);
  try {
    await redisClient.hdel(key, String(userId));
    return await getTypingUsers(groupId, userId);
  } catch (e) {
    logger.warn('Typing: stopTyping error', { message: e.message });
    return [];
  }
}

/**
 * Get all users currently typing in a group, excluding the given userId.
 * Also prunes stale entries (started > TYPING_TTL * 2 seconds ago).
 */
async function getTypingUsers(groupId, excludeUserId = null) {
  const key       = K.groupTyping(groupId);
  const ttlMs     = config.TTL.typing * 2 * 1000;
  const staleLimit = Date.now() - ttlMs;

  try {
    const all = await redisClient.hgetall(key);
    if (!all) return [];

    const typists   = [];
    const staleKeys = [];

    for (const [uid, raw] of Object.entries(all)) {
      const entry = JSON.parse(raw);
      const startedAt = new Date(entry.startedAt).getTime();

      if (startedAt < staleLimit) {
        // Stale entry — prune
        staleKeys.push(uid);
        continue;
      }

      if (String(uid) === String(excludeUserId)) continue;

      typists.push({ userId: Number(uid), name: entry.name });
    }

    // Prune stale entries
    if (staleKeys.length) {
      await redisClient.hdel(key, ...staleKeys).catch(() => {});
    }

    return typists;
  } catch (e) {
    logger.warn('Typing: getTypingUsers error', { message: e.message });
    return [];
  }
}

/**
 * Clear all typing indicators for a user across a list of groups.
 * Called on disconnect.
 */
async function clearUserTyping(userId, groupIds = []) {
  if (!groupIds.length) return;
  const pipeline = redisClient.pipeline();
  for (const groupId of groupIds) {
    pipeline.hdel(K.groupTyping(groupId), String(userId));
  }
  await pipeline.exec().catch(() => {});
}

module.exports = { startTyping, stopTyping, getTypingUsers, clearUserTyping };