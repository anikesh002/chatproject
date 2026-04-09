'use strict';

const membershipService = require('../services/membershipService');
const { query, execute } = require('../config/db');
const logger            = require('../utils/logger');

/**
 * AdminHandler
 *
 * Restricted events — teacher/admin only:
 *   'group:pin'    → pin a message
 *   'group:unpin'  → unpin current message
 *   'member:mute'  → mute a member (optionally with duration)
 *   'member:unmute'→ unmute a member
 *
 * These operations write to MySQL and broadcast the change to the room.
 * The Laravel backend is the source of truth; these are real-time shortcuts
 * that Node.js can apply without going through Laravel's HTTP layer.
 */

/**
 * Handle 'group:pin'
 *
 * Client emits:
 *   socket.emit('group:pin', { groupId, messageId }, callback)
 *
 * Broadcasts to room:
 *   'group:pinned' → { groupId, messageId, pinnedBy }
 */
async function handlePin(socket, io, { groupId, messageId }, callback) {
  if (!groupId || !messageId) return callback?.({ ok: false, error: 'groupId and messageId are required' });

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);
    if (!membershipService.isTeacherOrAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only teachers and admins can pin messages', code: 'FORBIDDEN' });
    }

    await execute(
      'UPDATE chat_groups SET pinned_message_id = ?, updated_at = NOW() WHERE id = ?',
      [messageId, groupId]
    );

    // Invalidate membership cache for the group (group state changed)
    // Note: pinned_message_id isn't in membership cache so no cache bust needed

    io.to(`group:${groupId}`).emit('group:pinned', {
      groupId,
      messageId,
      pinnedBy: { id: socket.userId, name: socket.userName },
    });

    logger.info('Message pinned', { groupId, messageId, userId: socket.userId });
    callback?.({ ok: true });
  } catch (err) {
    logger.error('group:pin error', { message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Handle 'group:unpin'
 */
async function handleUnpin(socket, io, { groupId }, callback) {
  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);
    if (!membershipService.isTeacherOrAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only teachers and admins can unpin messages', code: 'FORBIDDEN' });
    }

    await execute(
      'UPDATE chat_groups SET pinned_message_id = NULL, updated_at = NOW() WHERE id = ?',
      [groupId]
    );

    io.to(`group:${groupId}`).emit('group:unpinned', { groupId });
    logger.info('Message unpinned', { groupId, userId: socket.userId });
    callback?.({ ok: true });
  } catch (err) {
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Handle 'member:mute'
 *
 * Client emits:
 *   socket.emit('member:mute', {
 *     groupId:       5,
 *     targetUserId:  33,
 *     durationMinutes: 60,   // optional — omit for indefinite
 *   }, callback)
 *
 * Broadcasts to room:
 *   'member:muted' → { groupId, targetUserId, mutedUntil, mutedBy }
 */
async function handleMute(socket, io, { groupId, targetUserId, durationMinutes }, callback) {
  if (!groupId || !targetUserId) return callback?.({ ok: false, error: 'groupId and targetUserId are required' });
  if (targetUserId === socket.userId) return callback?.({ ok: false, error: 'Cannot mute yourself' });

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);
    if (!membershipService.isAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only admins can mute members', code: 'FORBIDDEN' });
    }

    // Verify target is a member
    const targetMembership = await membershipService.getMembership(groupId, targetUserId);
    if (!targetMembership) return callback?.({ ok: false, error: 'Target user is not a member of this group' });

    // Admins cannot be muted
    if (membershipService.isAdmin(targetMembership)) {
      return callback?.({ ok: false, error: 'Admins cannot be muted', code: 'FORBIDDEN' });
    }

    let mutedUntil = null;
    if (durationMinutes && Number(durationMinutes) > 0) {
      mutedUntil = new Date(Date.now() + Number(durationMinutes) * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .substring(0, 19);
    }

    await execute(
      `UPDATE chat_group_members
       SET is_muted = 1, muted_until = ?, updated_at = NOW()
       WHERE chat_group_id = ? AND user_id = ?`,
      [mutedUntil, groupId, targetUserId]
    );

    // Invalidate target's membership cache so next check picks up the mute
    await membershipService.invalidateMembershipCache(groupId, targetUserId);

    io.to(`group:${groupId}`).emit('member:muted', {
      groupId,
      targetUserId,
      mutedUntil,
      mutedBy: { id: socket.userId, name: socket.userName },
    });

    logger.info('Member muted', { groupId, targetUserId, mutedUntil, mutedBy: socket.userId });
    callback?.({ ok: true, mutedUntil });
  } catch (err) {
    logger.error('member:mute error', { message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Handle 'member:unmute'
 */
async function handleUnmute(socket, io, { groupId, targetUserId }, callback) {
  if (!groupId || !targetUserId) return callback?.({ ok: false, error: 'groupId and targetUserId are required' });

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);
    if (!membershipService.isAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only admins can unmute members', code: 'FORBIDDEN' });
    }

    await execute(
      `UPDATE chat_group_members
       SET is_muted = 0, muted_until = NULL, updated_at = NOW()
       WHERE chat_group_id = ? AND user_id = ?`,
      [groupId, targetUserId]
    );

    await membershipService.invalidateMembershipCache(groupId, targetUserId);

    io.to(`group:${groupId}`).emit('member:unmuted', {
      groupId,
      targetUserId,
      unmutedBy: { id: socket.userId, name: socket.userName },
    });

    logger.info('Member unmuted', { groupId, targetUserId, unmutedBy: socket.userId });
    callback?.({ ok: true });
  } catch (err) {
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

function register(socket, io) {
  socket.on('group:pin',     (data, cb) => handlePin(socket, io, data, cb));
  socket.on('group:unpin',   (data, cb) => handleUnpin(socket, io, data, cb));
  socket.on('member:mute',   (data, cb) => handleMute(socket, io, data, cb));
  socket.on('member:unmute', (data, cb) => handleUnmute(socket, io, data, cb));
}

module.exports = { register };