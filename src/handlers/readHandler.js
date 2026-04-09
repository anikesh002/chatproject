'use strict';

const membershipService = require('../services/membershipService');
const messageService    = require('../services/messageService');
const logger            = require('../utils/logger');

/**
 * ReadHandler
 *
 * Client events:
 *   'read:markUpTo'   → { groupId, lastMessageId }
 *   'read:getReaders' → { groupId, messageId }
 *
 * Server emits to sender:
 *   'read:confirmed' → { groupId, lastMessageId, markedCount }
 *   (callback)       → { ok: true, readers: [{ id, name, readAt }] }
 *
 * Server broadcasts to room:
 *   'read:receipt' → { groupId, userId, userName, lastMessageId }
 *   (so other group members can show read ticks)
 *
 * Note on archived groups:
 *   Both handlers use assertMembershipReadOnly — archived groups are
 *   read-only, so marking messages as read and fetching readers are
 *   still valid operations even after a batch is archived.
 *   Only inactive groups are fully blocked.
 */

/**
 * Handle 'read:markUpTo'
 *
 * Client emits:
 *   socket.emit('read:markUpTo', { groupId, lastMessageId }, callback)
 *
 * Server responds via callback:
 *   { ok: true, markedCount, lastMessageId }
 *
 * Server broadcasts to room:
 *   'read:receipt' → { groupId, userId, userName, lastMessageId }
 */
async function handleMarkRead(socket, io, data, callback) {
  const { groupId, lastMessageId } = data || {};

  if (!groupId || !lastMessageId) {
    return callback?.({ ok: false, error: 'groupId and lastMessageId are required' });
  }

  try {
    // Use read-only check — marking read is valid even in archived groups
    await membershipService.assertMembershipReadOnly(groupId, socket.userId);

    const result = await messageService.markAllReadUpTo(groupId, socket.userId, lastMessageId);

    // Broadcast receipt to other members in the room
    socket.to(`group:${groupId}`).emit('read:receipt', {
      groupId,
      userId:        socket.userId,
      userName:      socket.userName,
      lastMessageId,
    });

    callback?.({ ok: true, ...result });
  } catch (err) {
    logger.warn('read:markUpTo error', { userId: socket.userId, groupId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Handle 'read:getReaders'
 *
 * Returns the list of users who have read a specific message.
 * Used for "Seen by: Alice, Bob…" tooltip / modal in the UI.
 *
 * Client emits:
 *   socket.emit('read:getReaders', { groupId, messageId }, callback)
 *
 * Server responds via callback:
 *   { ok: true, messageId, readers: [{ id, name, readAt }] }
 *
 * Security:
 *   - Caller must be a member of the group (active or archived).
 *   - groupId is used only for the membership check; the actual read
 *     rows are scoped to messageId in the DB query.
 */
async function handleGetReaders(socket, io, data, callback) {
  const { groupId, messageId } = data || {};

  if (!groupId || !messageId) {
    return callback?.({ ok: false, error: 'groupId and messageId are required' });
  }

  try {
    // Use read-only check — viewing readers is valid even in archived groups
    await membershipService.assertMembershipReadOnly(groupId, socket.userId);

    const readers = await messageService.getReadersForMessage(messageId);

    callback?.({ ok: true, messageId, readers });
  } catch (err) {
    logger.warn('read:getReaders error', { userId: socket.userId, groupId, messageId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Register all read-related event handlers on a socket.
 */
function register(socket, io) {
  socket.on('read:markUpTo',   (data, cb) => handleMarkRead(socket, io, data, cb));
  socket.on('read:getReaders', (data, cb) => handleGetReaders(socket, io, data, cb));
}

module.exports = { register };