'use strict';

const { redisClient } = require('../config/redis');
const K              = require('../utils/redisKeys');
const config         = require('../config/env');
const logger         = require('../utils/logger');

/**
 * PresenceService
 *
 * Tracks which users are online in which groups using Redis hashes.
 *
 * Data structures:
 *
 *  lms:chat:presence:group:{groupId}  → HSET
 *    field: userId
 *    value: JSON { name, role, socketIds: [], joinedAt }
 *    TTL: refreshed on heartbeat (PRESENCE_TTL seconds)
 *
 *  lms:chat:sockets:user:{userId}  → SADD
 *    members: set of socket IDs (for multi-tab / multi-device)
 *
 *  lms:chat:presence:user:{userId}  → STRING
 *    value: JSON { name, groups: [], lastSeen }
 *    TTL: PRESENCE_TTL
 */

/**
 * Register a socket joining a group room.
 * Adds the socket to the user's presence entry in that group.
 */
async function userJoinedGroup(groupId, userId, socketId, name, role) {
  const groupKey  = K.groupPresence(groupId);
  const socketKey = K.userSockets(userId);
  const userKey   = K.userPresence(userId);
  const ttl       = config.TTL.presence;

  try {
    // Fetch existing presence for this user in this group
    const existing = await redisClient.hget(groupKey, String(userId));
    let presenceEntry;

    if (existing) {
      presenceEntry = JSON.parse(existing);
      if (!presenceEntry.socketIds.includes(socketId)) {
        presenceEntry.socketIds.push(socketId);
      }
    } else {
      presenceEntry = {
        userId,
        name,
        role,
        socketIds: [socketId],
        joinedAt:  new Date().toISOString(),
      };
    }

    const pipeline = redisClient.pipeline();
    pipeline.hset(groupKey, String(userId), JSON.stringify(presenceEntry));
    pipeline.expire(groupKey, ttl * 10); // group presence lasts longer
    pipeline.sadd(socketKey, socketId);
    pipeline.expire(socketKey, ttl * 10);

    // Update per-user global presence
    const userPresenceRaw  = await redisClient.get(userKey);
    const userPresence     = userPresenceRaw ? JSON.parse(userPresenceRaw) : { name, groups: [], lastSeen: null };
    if (!userPresence.groups.includes(Number(groupId))) {
      userPresence.groups.push(Number(groupId));
    }
    userPresence.lastSeen = new Date().toISOString();
    pipeline.setex(userKey, ttl, JSON.stringify(userPresence));

    await pipeline.exec();

    logger.debug('Presence: user joined group', { userId, groupId, socketId });
  } catch (e) {
    logger.error('Presence: userJoinedGroup error', { message: e.message });
  }
}

/**
 * Remove a socket from all group presence entries when it disconnects.
 * If the user has no more sockets in a group, they are considered offline.
 *
 * @param {string}   socketId
 * @param {number}   userId
 * @param {number[]} groupIds  — groups the socket was subscribed to
 */
async function userLeft(socketId, userId, groupIds = []) {
  const socketKey = K.userSockets(userId);

  try {
    const pipeline = redisClient.pipeline();
    pipeline.srem(socketKey, socketId);

    // Check remaining sockets for this user
    const remainingSockets = await redisClient.smembers(socketKey);
    const otherSockets     = remainingSockets.filter((s) => s !== socketId);

    for (const groupId of groupIds) {
      const groupKey  = K.groupPresence(groupId);
      const existing  = await redisClient.hget(groupKey, String(userId));
      if (!existing) continue;

      const entry = JSON.parse(existing);
      entry.socketIds = entry.socketIds.filter((s) => s !== socketId);

      if (entry.socketIds.length === 0 || otherSockets.length === 0) {
        // User is fully offline in this group
        pipeline.hdel(groupKey, String(userId));
        logger.debug('Presence: user left group (no more sockets)', { userId, groupId });
      } else {
        // Still has other open connections
        pipeline.hset(groupKey, String(userId), JSON.stringify(entry));
      }
    }

    // Update global user presence
    if (otherSockets.length === 0) {
      const userKey = K.userPresence(userId);
      const raw     = await redisClient.get(userKey);
      if (raw) {
        const userPresence    = JSON.parse(raw);
        userPresence.groups   = [];
        userPresence.lastSeen = new Date().toISOString();
        pipeline.setex(userKey, config.TTL.presence, JSON.stringify(userPresence));
      }
    }

    await pipeline.exec();
  } catch (e) {
    logger.error('Presence: userLeft error', { message: e.message });
  }
}

/**
 * Get all online users in a group.
 * Returns: Array of { userId, name, role, joinedAt }
 */
async function getGroupPresence(groupId) {
  try {
    const groupKey = K.groupPresence(groupId);
    const all      = await redisClient.hgetall(groupKey);
    if (!all) return [];
    return Object.values(all).map((v) => {
      const p = JSON.parse(v);
      return {
        userId:   p.userId,
        name:     p.name,
        role:     p.role,
        joinedAt: p.joinedAt,
      };
    });
  } catch (e) {
    logger.error('Presence: getGroupPresence error', { message: e.message });
    return [];
  }
}

/**
 * Refresh presence TTL on heartbeat/ping.
 */
async function refreshPresence(userId, groupIds = []) {
  const ttl = config.TTL.presence;
  try {
    const pipeline = redisClient.pipeline();
    pipeline.expire(K.userPresence(userId), ttl);
    pipeline.expire(K.userSockets(userId), ttl * 10);
    for (const groupId of groupIds) {
      pipeline.expire(K.groupPresence(groupId), ttl * 10);
    }
    await pipeline.exec();
  } catch (e) {
    logger.warn('Presence: refresh error', { message: e.message });
  }
}

/**
 * Check if a specific user is online in a specific group.
 */
async function isUserOnlineInGroup(groupId, userId) {
  try {
    const result = await redisClient.hexists(K.groupPresence(groupId), String(userId));
    return result === 1;
  } catch (e) {
    return false;
  }
}

module.exports = {
  userJoinedGroup,
  userLeft,
  getGroupPresence,
  refreshPresence,
  isUserOnlineInGroup,
};