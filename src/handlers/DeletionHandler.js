'use strict';

const membershipService = require('../services/membershipService');
const messageService    = require('../services/messageService');
const logger            = require('../utils/logger');

/**
 * DeletionHandler
 *
 * Handles all real-time message deletion and clear-chat events.
 *
 * ┌─────────────────────────────┬──────────────────────────────────────────┐
 * │ Event                       │ Who sees the effect                      │
 * ├─────────────────────────────┼──────────────────────────────────────────┤
 * │ message:deleteForMe         │ Requesting user only                     │
 * │ message:deleteForEveryone   │ All members (broadcasts message:deleted) │
 * │ message:bulkDeleteForMe     │ Requesting user only                     │
 * │ chat:clear                  │ Requesting user only                     │
 * └─────────────────────────────┴──────────────────────────────────────────┘
 */

const DELETE_FOR_EVERYONE_WINDOW_MINUTES = 60;

// ---------------------------------------------------------------
// message:deleteForMe
//
// Hides a single message for the requesting socket user only.
// No broadcast — other users are completely unaffected.
//
// Client emits:
//   socket.emit('message:deleteForMe', { messageId }, callback)
//
// Callback:
//   { ok: true }
// ---------------------------------------------------------------
async function handleDeleteForMe(socket, io, data, callback) {
  const { messageId } = data || {};
  if (!messageId) return callback?.({ ok: false, error: 'messageId is required' });

  try {
    const meta = await messageService.getMessageMeta(messageId);
    if (!meta) return callback?.({ ok: false, error: 'Message not found', code: 'NOT_FOUND' });

    // Membership check — user must be in the group (read-only ok)
    await membershipService.assertMembershipReadOnly(meta.groupId, socket.userId);

    await messageService.deleteForMe(messageId, socket.userId);

    // No broadcast — this is private to the requesting user
    logger.info('Message deleted for me', { messageId, userId: socket.userId });
    callback?.({ ok: true });
  } catch (err) {
    logger.warn('message:deleteForMe error', { userId: socket.userId, messageId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

// ---------------------------------------------------------------
// message:deleteForEveryone
//
// Soft-deletes a message for ALL users in the group.
// Sender can do this within the time window; admin always can.
//
// Client emits:
//   socket.emit('message:deleteForEveryone', { messageId }, callback)
//
// Broadcasts to room:
//   'message:deleted' → { messageId, groupId, deletedBy }
// ---------------------------------------------------------------
async function handleDeleteForEveryone(socket, io, data, callback) {
  const { messageId } = data || {};
  if (!messageId) return callback?.({ ok: false, error: 'messageId is required' });

  try {
    const meta = await messageService.getMessageMeta(messageId);
    if (!meta) return callback?.({ ok: false, error: 'Message not found', code: 'NOT_FOUND' });

    const membership = await membershipService.assertMembership(meta.groupId, socket.userId);

    const isSender = meta.senderId === socket.userId;
    const isAdmin  = membershipService.isAdmin(membership);

    if (!isSender && !isAdmin) {
      return callback?.({ ok: false, error: 'Permission denied', code: 'FORBIDDEN' });
    }

    // Enforce time window for non-admin senders
    if (isSender && !isAdmin) {
      const ageMs      = Date.now() - new Date(meta.createdAt).getTime();
      const ageMinutes = ageMs / 1000 / 60;
      if (ageMinutes > DELETE_FOR_EVERYONE_WINDOW_MINUTES) {
        return callback?.({
          ok:    false,
          error: `You can only delete your own messages within ${DELETE_FOR_EVERYONE_WINDOW_MINUTES} minutes of sending.`,
          code:  'WINDOW_EXPIRED',
        });
      }
    }

    const deleted = await messageService.deleteMessage(messageId); // soft delete
    if (!deleted) return callback?.({ ok: false, error: 'Message already deleted' });

    // Broadcast to everyone in the group
    io.to(`group:${meta.groupId}`).emit('message:deleted', {
      messageId,
      groupId:   meta.groupId,
      deletedBy: socket.userId,
    });

    logger.info('Message deleted for everyone', { messageId, userId: socket.userId, isAdmin });
    callback?.({ ok: true });
  } catch (err) {
    logger.error('message:deleteForEveryone error', { userId: socket.userId, messageId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

// ---------------------------------------------------------------
// message:bulkDeleteForMe
//
// Hides multiple messages at once for the requesting user only.
// Used when user selects multiple messages and taps "Delete for me".
//
// Client emits:
//   socket.emit('message:bulkDeleteForMe', { groupId, messageIds: [1,2,3] }, callback)
//
// Callback:
//   { ok: true, count: 3 }
// ---------------------------------------------------------------
async function handleBulkDeleteForMe(socket, io, data, callback) {
  const { groupId, messageIds } = data || {};

  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });
  if (!Array.isArray(messageIds) || !messageIds.length) {
    return callback?.({ ok: false, error: 'messageIds must be a non-empty array' });
  }
  if (messageIds.length > 100) {
    return callback?.({ ok: false, error: 'Cannot delete more than 100 messages at once' });
  }

  try {
    await membershipService.assertMembershipReadOnly(groupId, socket.userId);

    const count = await messageService.bulkDeleteForMe(messageIds, socket.userId);

    logger.info('Bulk delete for me', { userId: socket.userId, groupId, count });
    callback?.({ ok: true, count });
  } catch (err) {
    logger.warn('message:bulkDeleteForMe error', { userId: socket.userId, groupId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

// ---------------------------------------------------------------
// chat:clear
//
// Clears entire chat history for the requesting user only.
// Sets a watermark timestamp — all messages before now() are
// hidden for this user. Others are completely unaffected.
//
// Client emits:
//   socket.emit('chat:clear', { groupId }, callback)
//
// Callback:
//   { ok: true, clearedAt: '2025-01-01T10:00:00Z' }
// ---------------------------------------------------------------
async function handleClearChat(socket, io, data, callback) {
  const { groupId } = data || {};
  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });

  try {
    // Allow on archived groups too — user should be able to clear
    // read-only history they no longer want to see
    await membershipService.assertMembershipReadOnly(groupId, socket.userId);

    const clearedAt = await messageService.clearChatForUser(groupId, socket.userId);

    // No broadcast — private to this user only
    logger.info('Chat cleared for user', { userId: socket.userId, groupId, clearedAt });
    callback?.({ ok: true, clearedAt });
  } catch (err) {
    logger.warn('chat:clear error', { userId: socket.userId, groupId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

function register(socket, io) {
  socket.on('message:deleteForMe',       (data, cb) => handleDeleteForMe(socket, io, data, cb));
  socket.on('message:deleteForEveryone', (data, cb) => handleDeleteForEveryone(socket, io, data, cb));
  socket.on('message:bulkDeleteForMe',   (data, cb) => handleBulkDeleteForMe(socket, io, data, cb));
  socket.on('chat:clear',                (data, cb) => handleClearChat(socket, io, data, cb));
}

module.exports = { register };