'use strict';

const membershipService = require('../services/membershipService');
const typingService     = require('../services/typingService');
const logger            = require('../utils/logger');

/**
 * TypingHandler
 *
 * Client events:
 *   'typing:start' → { groupId }
 *   'typing:stop'  → { groupId }
 *
 * Server broadcasts to room (excluding sender):
 *   'typing:update' → { groupId, typists: [{ userId, name }] }
 *
 * Design notes:
 *   - Client should debounce 'typing:start' to ~1s intervals
 *   - Client should emit 'typing:stop' on input blur / message send
 *   - Redis auto-expires the entry after TYPING_TTL if stop is not emitted
 *   - Muted users can still show typing indicators (they just can't send)
 *   - Typing is only allowed in active groups — silently ignored for
 *     archived/inactive groups (no error thrown to client)
 */

async function handleTypingStart(socket, io, { groupId }, callback) {
  if (!groupId) return;

  try {
    const membership = await membershipService.getMembership(groupId, socket.userId);

    if (!membership || membership.groupStatus !== membershipService.GROUP_STATUS.ACTIVE) return;

    const typists = await typingService.startTyping(groupId, socket.userId, socket.userName);

    socket.to(`group:${groupId}`).emit('typing:update', { groupId, typists });

    callback?.({ ok: true });
  } catch (err) {
    logger.warn('typing:start error', { userId: socket.userId, groupId, message: err.message });
  }
}

async function handleTypingStop(socket, io, { groupId }, callback) {
  if (!groupId) return;

  try {
    const typists = await typingService.stopTyping(groupId, socket.userId);
    socket.to(`group:${groupId}`).emit('typing:update', { groupId, typists });
    callback?.({ ok: true });
  } catch (err) {
    logger.warn('typing:stop error', { userId: socket.userId, groupId, message: err.message });
  }
}

function register(socket, io) {
  socket.on('typing:start', (data, cb) => handleTypingStart(socket, io, data, cb));
  socket.on('typing:stop',  (data, cb) => handleTypingStop(socket, io, data, cb));
}

module.exports = { register };