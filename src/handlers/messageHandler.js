'use strict';

const membershipService = require('../services/membershipService');
const messageService    = require('../services/messageService');
const rateLimitService  = require('../services/rateLimitService');
const typingService     = require('../services/typingService');
const logger            = require('../utils/logger');

// 'system' added — only server/admin can emit this, guarded below
const ALLOWED_TYPES = ['text', 'image', 'file', 'announcement', 'system'];

async function handleSend(socket, io, data, callback) {
  const { groupId, type = 'text', text, replyToId = null } = data || {};

  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });
  if (!ALLOWED_TYPES.includes(type)) return callback?.({ ok: false, error: `Invalid message type: ${type}` });
  if (type === 'text' && (!text || !text.trim())) return callback?.({ ok: false, error: 'Text message cannot be empty' });
  if (text && text.length > 5000) return callback?.({ ok: false, error: 'Message too long (max 5000 characters)' });

  // System messages must go through handleSystemSend — not via client emit
  if (type === 'system') {
    return callback?.({ ok: false, error: 'System messages cannot be sent by clients', code: 'FORBIDDEN' });
  }

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);

    if (!membershipService.canSendMessage(membership)) {
      return callback?.({ ok: false, error: 'You are currently muted in this group', code: 'MUTED', mutedUntil: membership.mutedUntil });
    }

    if (type === 'announcement' && !membershipService.canSendAnnouncement(membership)) {
      return callback?.({ ok: false, error: 'Only teachers and admins can send announcements', code: 'FORBIDDEN' });
    }

    const rate = await rateLimitService.checkMessageRate(socket.userId, groupId, membership.role);
    if (!rate.allowed) {
      return callback?.({ ok: false, error: `Rate limit exceeded. Try again in ${rate.resetInSeconds}s`, code: 'RATE_LIMITED', resetInSeconds: rate.resetInSeconds });
    }

    const saved       = await messageService.createMessage({ groupId, senderId: socket.userId, type, text: text?.trim() || null, replyToId });
    const fullMessage = await messageService.getMessageWithDetails(saved.id);
    const updatedTypists = await typingService.stopTyping(groupId, socket.userId);

    const room = `group:${groupId}`;
    io.to(room).emit('message:new', fullMessage);
    io.to(room).emit('typing:update', { groupId, typists: updatedTypists });

    logger.info('Message sent', { messageId: saved.id, groupId, senderId: socket.userId, type });
    callback?.({ ok: true, message: fullMessage });
  } catch (err) {
    logger.error('message:send error', { userId: socket.userId, groupId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Send a system message to a group.
 *
 * Called server-side only — NOT exposed to client socket events.
 * Use this when a server action needs to notify a group:
 *   e.g. user joined, batch renamed, poll created.
 *
 * Usage (from another handler):
 *   await sendSystemMessage(io, groupId, 'Ravi Kumar joined the group.');
 */
async function sendSystemMessage(io, groupId, text) {
  try {
    const saved       = await messageService.createSystemMessage(groupId, text);
    const fullMessage = await messageService.getMessageWithDetails(saved.id);

    io.to(`group:${groupId}`).emit('message:new', fullMessage);

    logger.info('System message sent', { messageId: saved.id, groupId, text });
    return fullMessage;
  } catch (err) {
    logger.error('System message failed', { groupId, text, message: err.message });
    throw err;
  }
}

async function handleEdit(socket, io, data, callback) {
  const { messageId, text } = data || {};

  if (!messageId) return callback?.({ ok: false, error: 'messageId is required' });
  if (!text || !text.trim()) return callback?.({ ok: false, error: 'Text cannot be empty' });
  if (text.length > 5000) return callback?.({ ok: false, error: 'Message too long' });

  try {
    const meta = await messageService.getMessageMeta(messageId);
    if (!meta) return callback?.({ ok: false, error: 'Message not found', code: 'NOT_FOUND' });

    if (meta.senderId !== socket.userId) {
      return callback?.({ ok: false, error: 'Only the sender can edit this message', code: 'FORBIDDEN' });
    }

    if (['system', 'announcement'].includes(meta.type)) {
      return callback?.({ ok: false, error: 'This message type cannot be edited', code: 'FORBIDDEN' });
    }

    await membershipService.assertMembership(meta.groupId, socket.userId);

    const updated = await messageService.editMessage(messageId, text.trim());

    io.to(`group:${meta.groupId}`).emit('message:edited', {
      messageId,
      text:     updated.text,
      editedAt: updated.editedAt,
      groupId:  meta.groupId,
    });

    logger.info('Message edited', { messageId, userId: socket.userId });
    callback?.({ ok: true, ...updated });
  } catch (err) {
    logger.error('message:edit error', { userId: socket.userId, messageId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

async function handleDelete(socket, io, data, callback) {
  const { messageId } = data || {};
  if (!messageId) return callback?.({ ok: false, error: 'messageId is required' });

  try {
    const meta = await messageService.getMessageMeta(messageId);
    if (!meta) return callback?.({ ok: false, error: 'Message not found', code: 'NOT_FOUND' });

    const membership = await membershipService.assertMembership(meta.groupId, socket.userId);
    const isSender   = meta.senderId === socket.userId;
    const isAdmin    = membershipService.isAdmin(membership);

    if (!isSender && !isAdmin) {
      return callback?.({ ok: false, error: 'Permission denied', code: 'FORBIDDEN' });
    }

    const deleted = await messageService.deleteMessage(messageId);
    if (!deleted) return callback?.({ ok: false, error: 'Message already deleted' });

    io.to(`group:${meta.groupId}`).emit('message:deleted', {
      messageId,
      groupId:   meta.groupId,
      deletedBy: socket.userId,
    });

    logger.info('Message deleted', { messageId, userId: socket.userId, isAdmin });
    callback?.({ ok: true });
  } catch (err) {
    logger.error('message:delete error', { userId: socket.userId, messageId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

function register(socket, io) {
  socket.on('message:send',   (data, cb) => handleSend(socket, io, data, cb));
  socket.on('message:edit',   (data, cb) => handleEdit(socket, io, data, cb));
  socket.on('message:delete', (data, cb) => handleDelete(socket, io, data, cb));
}

module.exports = { register, sendSystemMessage };