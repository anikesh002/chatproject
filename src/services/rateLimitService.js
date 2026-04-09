'use strict';

const { redisClient } = require('../config/redis');
const K              = require('../utils/redisKeys');
const config         = require('../config/env');
const logger         = require('../utils/logger');

/**
 * RateLimitService
 *
 * Sliding window rate limiter using Redis INCR + EXPIRE.
 *
 * Per-user, per-group limit to prevent message flooding.
 * Teachers and admins are exempt (or have higher limits).
 *
 * Returns: { allowed: boolean, remaining: number, resetInSeconds: number }
 */
async function checkMessageRate(userId, groupId, role) {
  // Teachers and admins bypass rate limiting
  if (role === 'teacher' || role === 'admin') {
    return { allowed: true, remaining: Infinity, resetInSeconds: 0 };
  }

  const key   = K.rateLimit(userId, groupId);
  const limit = config.RATE_LIMIT.messages;
  const windowSeconds = config.RATE_LIMIT.windowSeconds;

  try {
    const pipeline = redisClient.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);
    const [[, count], [, ttl]] = await pipeline.exec();

    // Set expiry on first request
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }

    const currentTtl = ttl > 0 ? ttl : windowSeconds;

    if (count > limit) {
      logger.warn('Rate limit exceeded', { userId, groupId, count, limit });
      return {
        allowed:          false,
        remaining:        0,
        resetInSeconds:   currentTtl,
      };
    }

    return {
      allowed:          true,
      remaining:        limit - count,
      resetInSeconds:   currentTtl,
    };
  } catch (e) {
    // On Redis failure, allow the message (fail open for UX)
    logger.error('Rate limit check failed, allowing message', { message: e.message });
    return { allowed: true, remaining: -1, resetInSeconds: 0 };
  }
}

module.exports = { checkMessageRate };