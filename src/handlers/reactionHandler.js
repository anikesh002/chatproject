'use strict';

const membershipService = require('../services/membershipService');
const messageService    = require('../services/messageService');
const logger            = require('../utils/logger');

// Basic emoji validation — must be a non-empty string ≤ 10 chars
function isValidEmoji(emoji) {
  return typeof emoji === 'string' && emoji.trim().length > 0 && emoji.length <= 10;
}

/**
 * Handle 'reaction:toggle'
 *
 * Uses assertMembershipReadOnly — reactions are valid on archived groups
 * (read-only history). Only inactive groups are fully blocked.
 *
 * Client emits:
 *   socket.emit('reaction:toggle', { messageId: 42, emoji: '👍' }, callback)
 *
 * Server broadcasts to room:
 *   'reaction:updated' → { messageId, groupId, emoji, action, reactions }
 */
async function handleToggle(socket, io, data, callback) {
  const { messageId, emoji } = data || {};

  if (!messageId) return callback?.({ ok: false, error: 'messageId is required' });
  if (!isValidEmoji(emoji)) return callback?.({ ok: false, error: 'Invalid emoji' });

  try {
    const meta = await messageService.getMessageMeta(messageId);
    if (!meta) return callback?.({ ok: false, error: 'Message not found', code: 'NOT_FOUND' });

    // Read-only check — archived groups can still receive reactions
    await membershipService.assertMembershipReadOnly(meta.groupId, socket.userId);

    const result = await messageService.toggleReaction(messageId, socket.userId, emoji.trim());

    const payload = {
      messageId,
      groupId:   meta.groupId,
      emoji:     result.emoji,
      action:    result.action,
      reactions: result.reactions,
    };

    io.to(`group:${meta.groupId}`).emit('reaction:updated', payload);

    logger.debug('Reaction toggled', { messageId, userId: socket.userId, emoji, action: result.action });
    callback?.({ ok: true, ...payload });
  } catch (err) {
    logger.error('reaction:toggle error', { userId: socket.userId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

function register(socket, io) {
  socket.on('reaction:toggle', (data, cb) => handleToggle(socket, io, data, cb));
}

module.exports = { register };