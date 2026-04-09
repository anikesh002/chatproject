'use strict';

const { query, execute } = require('../config/db');
const { redisClient }    = require('../config/redis');
const K                  = require('../utils/redisKeys');
const config             = require('../config/env');
const logger             = require('../utils/logger');

/**
 * Roles matching ChatGroupMemberRole enum in Laravel:
 *   student | teacher | admin
 */
const ROLES = {
  STUDENT: 'student',
  TEACHER: 'teacher',
  ADMIN:   'admin',
};

/**
 * Group statuses matching ChatGroupStatus enum in Laravel:
 *   active | archived | inactive
 *
 * Only 'active' groups allow new messages.
 * 'archived' groups are read-only (history visible).
 * 'inactive' groups are fully disabled.
 */
const GROUP_STATUS = {
  ACTIVE:   'active',
  ARCHIVED: 'archived',
  INACTIVE: 'inactive',
};

/**
 * Fetch a user's membership for a chat group.
 *
 * Returns: { role, isMuted, mutedUntil, groupStatus } or null if not a member.
 *
 * Uses a two-layer cache:
 *   L1: Redis (TTL = MEMBERSHIP_CACHE_TTL)
 *   L2: MySQL chat_group_members
 *
 * The Laravel backend is responsible for writing membership records.
 * This service only reads them (with caching) for real-time permission checks.
 */
async function getMembership(groupId, userId) {
  const cacheKey = K.membershipCache(groupId, userId);

  // ── L1: Redis ──────────────────────────────────────────────────
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached === 'NOT_MEMBER') return null;
    if (cached) return JSON.parse(cached);
  } catch (e) {
    logger.warn('Membership cache read failed, falling back to DB', { message: e.message });
  }

  // ── L2: MySQL ──────────────────────────────────────────────────
  const rows = await query(
    `SELECT
       cgm.role,
       cgm.is_muted    AS isMuted,
       cgm.muted_until AS mutedUntil,
       cg.status       AS groupStatus
     FROM chat_group_members cgm
     INNER JOIN chat_groups cg ON cg.id = cgm.chat_group_id
     WHERE cgm.chat_group_id = ?
       AND cgm.user_id = ?
       AND cg.deleted_at IS NULL
     LIMIT 1`,
    [groupId, userId]
  );

  if (!rows.length) {
    // Cache negative result
    await redisClient.setex(cacheKey, config.TTL.membership, 'NOT_MEMBER').catch(() => {});
    return null;
  }

  const row = rows[0];
  const membership = {
    role:        row.role,
    isMuted:     !!row.isMuted,
    mutedUntil:  row.mutedUntil,
    groupStatus: row.groupStatus,  // 'active' | 'archived' | 'inactive'
  };

  await redisClient
    .setex(cacheKey, config.TTL.membership, JSON.stringify(membership))
    .catch(() => {});

  return membership;
}

/**
 * Invalidate cached membership for a user/group pair.
 * Called after Laravel changes group membership or group status.
 */
async function invalidateMembershipCache(groupId, userId) {
  const key = K.membershipCache(groupId, userId);
  await redisClient.del(key).catch(() => {});
  logger.debug('Membership cache invalidated', { groupId, userId });
}

/**
 * Validate that a user is a member of the group AND the group is active.
 *
 * Throws with a structured error code on failure:
 *   NOT_MEMBER     — user is not in the group
 *   GROUP_INACTIVE — group status is 'archived' or 'inactive'
 *
 * Note: archived groups block new messages (read-only).
 * If you need to allow reads from archived groups, call getMembership()
 * directly and check groupStatus yourself.
 */
async function assertMembership(groupId, userId) {
  const membership = await getMembership(groupId, userId);

  if (!membership) {
    const err = new Error('You are not a member of this group');
    err.code  = 'NOT_MEMBER';
    throw err;
  }

  if (membership.groupStatus !== GROUP_STATUS.ACTIVE) {
    const err = new Error('This chat group is no longer active');
    err.code  = 'GROUP_INACTIVE';
    throw err;
  }

  return membership;
}

/**
 * Like assertMembership but allows archived groups (read-only access).
 * Use for read:getReaders, message history, reactions — anything that
 * doesn't require the group to accept new messages.
 */
async function assertMembershipReadOnly(groupId, userId) {
  const membership = await getMembership(groupId, userId);

  if (!membership) {
    const err = new Error('You are not a member of this group');
    err.code  = 'NOT_MEMBER';
    throw err;
  }

  if (membership.groupStatus === GROUP_STATUS.INACTIVE) {
    const err = new Error('This chat group is disabled');
    err.code  = 'GROUP_INACTIVE';
    throw err;
  }

  return membership;
}

/**
 * Check if a user's mute is currently in effect.
 * A muted_until=null means muted indefinitely.
 */
function isMutedNow(membership) {
  if (!membership.isMuted) return false;
  if (!membership.mutedUntil) return true; // indefinite mute
  return new Date(membership.mutedUntil) > new Date();
}

/**
 * Determine if the member can send new messages.
 */
function canSendMessage(membership) {
  if (!membership) return false;
  return !isMutedNow(membership);
}

/**
 * Only teachers and admins can send announcements.
 */
function canSendAnnouncement(membership) {
  return membership && [ROLES.TEACHER, ROLES.ADMIN].includes(membership.role);
}

/**
 * Only admins can delete others' messages, mute members, pin messages.
 */
function isAdmin(membership) {
  return membership && membership.role === ROLES.ADMIN;
}

/**
 * Teachers and admins have elevated permissions.
 */
function isTeacherOrAdmin(membership) {
  return membership && [ROLES.TEACHER, ROLES.ADMIN].includes(membership.role);
}

module.exports = {
  ROLES,
  GROUP_STATUS,
  getMembership,
  assertMembership,
  assertMembershipReadOnly,
  invalidateMembershipCache,
  isMutedNow,
  canSendMessage,
  canSendAnnouncement,
  isAdmin,
  isTeacherOrAdmin,
};