'use strict';

const crypto = require('crypto');
const { query } = require('../config/db');
const { redisClient } = require('../config/redis');
const K      = require('../utils/redisKeys');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Hash a plain-text Sanctum token the same way Laravel does:
 *
 *   $hash = hash('sha256', $plainTextToken);
 *
 * Laravel stores only the hash in personal_access_tokens.token.
 * The client sends the plain "id|token" string from createToken().
 */
function hashToken(plainToken) {
  return crypto.createHash('sha256').update(plainToken).digest('hex');
}

/**
 * Parse a Sanctum token of the form:  "<id>|<plain_token>"
 * Returns { tokenId, plainToken } or null if malformed.
 *
 * Example token value from the Authorization header:
 *   Bearer 42|abc123def456...
 */
function parseSanctumToken(raw) {
  const parts = raw.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { tokenId: parseInt(parts[0], 10), plainToken: parts[1] };
}

/**
 * Validate a Sanctum token against the database.
 *
 * 1. Parse "<id>|<token>" from the bearer string
 * 2. Hash the plain token with sha256
 * 3. Query personal_access_tokens WHERE id = ? AND token = ?
 * 4. Verify user.is_active = 1
 * 5. Cache result in Redis for TOKEN_CACHE_TTL seconds
 *
 * Returns: { userId, userName, userEmail, role: null }
 * Throws:  Error with code 'AUTH_FAILED' | 'USER_INACTIVE'
 */
async function validateSanctumToken(rawToken) {
  const parsed = parseSanctumToken(rawToken);
  if (!parsed) {
    const err = new Error('Malformed Sanctum token');
    err.code  = 'AUTH_FAILED';
    throw err;
  }

  const { tokenId, plainToken } = parsed;
  const hashedToken = hashToken(plainToken);
  const cacheKey    = K.tokenCache(hashedToken);

  // ── 1. Check Redis cache first ────────────────────────────────
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached === 'INVALID') {
      const err = new Error('Token is invalid or expired (cached)');
      err.code  = 'AUTH_FAILED';
      throw err;
    }
    if (cached) {
      const data = JSON.parse(cached);
      logger.debug('Token resolved from cache', { userId: data.userId });
      return data;
    }
  } catch (redisErr) {
    if (redisErr.code === 'AUTH_FAILED') throw redisErr;
    // Redis miss/error → fall through to DB
    logger.warn('Redis cache miss for token, falling back to DB', { message: redisErr.message });
  }

  // ── 2. Query DB: personal_access_tokens JOIN users ────────────
  const rows = await query(
    `SELECT
       pat.id          AS tokenId,
       pat.tokenable_id AS userId,
       pat.expires_at,
       u.name          AS userName,
       u.email         AS userEmail,
       u.is_active     AS isActive
     FROM personal_access_tokens pat
     INNER JOIN users u ON u.id = pat.tokenable_id
     WHERE pat.id = ?
       AND pat.token = ?
       AND pat.tokenable_type = 'App\\\\Models\\\\User'
     LIMIT 1`,
    [tokenId, hashedToken]
  );

  if (!rows.length) {
    // Cache negative result briefly to stop DB hammering on replayed invalid tokens
    await redisClient.setex(cacheKey, 60, 'INVALID').catch(() => {});
    const err = new Error('Token not found or hash mismatch');
    err.code  = 'AUTH_FAILED';
    throw err;
  }

  const row = rows[0];

  // ── 3. Check expiry (Sanctum tokens may have expires_at) ─────
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await redisClient.setex(cacheKey, 60, 'INVALID').catch(() => {});
    const err = new Error('Token has expired');
    err.code  = 'AUTH_FAILED';
    throw err;
  }

  // ── 4. Check user is active ───────────────────────────────────
  if (!row.isActive) {
    await redisClient.setex(cacheKey, 60, 'INVALID').catch(() => {});
    const err = new Error('User account is inactive');
    err.code  = 'USER_INACTIVE';
    throw err;
  }

  // ── 5. Update last_used_at (fire-and-forget) ─────────────────
  query('UPDATE personal_access_tokens SET last_used_at = NOW() WHERE id = ?', [tokenId])
    .catch((e) => logger.warn('Failed to update last_used_at', { message: e.message }));

  const userData = {
    userId:    row.userId,
    userName:  row.userName,
    userEmail: row.userEmail,
  };

  // ── 6. Cache valid result ─────────────────────────────────────
  await redisClient.setex(cacheKey, config.TTL.token, JSON.stringify(userData)).catch(() => {});

  return userData;
}

/**
 * Socket.IO middleware — authenticates every incoming connection.
 *
 * Client must send token in handshake:
 *   socket = io(URL, { auth: { token: '<id>|<plain>' } })
 *
 * On success, attaches to socket:
 *   socket.userId, socket.userName, socket.userEmail
 */
async function authenticateSocket(socket, next) {
  try {
    const raw = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
    if (!raw) {
      return next(new Error('No authentication token provided'));
    }

    // Strip "Bearer " prefix if sent in Authorization header
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;

    const userData = await validateSanctumToken(token);

    socket.userId    = userData.userId;
    socket.userName  = userData.userName;
    socket.userEmail = userData.userEmail;

    logger.info('Socket authenticated', {
      socketId: socket.id,
      userId:   socket.userId,
      name:     socket.userName,
    });

    next();
  } catch (err) {
    logger.warn('Socket auth failed', {
      socketId: socket.id,
      code:     err.code,
      message:  err.message,
    });
    next(new Error(err.message));
  }
}

module.exports = { authenticateSocket, validateSanctumToken, hashToken };