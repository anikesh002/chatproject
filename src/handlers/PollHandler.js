'use strict';

const membershipService = require('../services/membershipService');
const pollService       = require('../services/pollService');
const logger            = require('../utils/logger');

/**
 * PollHandler
 *
 * Handles all real-time poll socket events.
 *
 * ┌──────────────────┬───────────────────────────────────────────────────────┐
 * │ Event            │ Description                                           │
 * ├──────────────────┼───────────────────────────────────────────────────────┤
 * │ poll:create      │ Teacher creates a poll — broadcasts message:new       │
 * │ poll:vote        │ User votes — broadcasts poll:updated to the room      │
 * │ poll:retract     │ User retracts vote — broadcasts poll:updated          │
 * │ poll:close       │ Teacher closes poll — broadcasts poll:closed          │
 * └──────────────────┴───────────────────────────────────────────────────────┘
 *
 * All broadcasts go to `group:{groupId}` so every connected member gets
 * live updates without needing to re-fetch.
 *
 */

// ─────────────────────────────────────────────────────────────────────────────
// poll:create
// ─────────────────────────────────────────────────────────────────────────────
async function handleCreate(socket, io, data, callback) {
  const { groupId, question, options, allowMultiple = false, anonymous = false } = data || {};

  if (!groupId)  return callback?.({ ok: false, error: 'groupId is required' });
  if (!question) return callback?.({ ok: false, error: 'question is required' });
  if (!Array.isArray(options) || options.length < 2) {
    return callback?.({ ok: false, error: 'At least 2 options are required' });
  }

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);

    if (!membershipService.isTeacherOrAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only teachers can create polls', code: 'FORBIDDEN' });
    }

    const result = await pollService.create({
      groupId,
      creatorId:    socket.userId,
      question:     question.trim(),
      options,
      allowMultiple,
      anonymous,
    });

    // Broadcast the message row so the FlatList renders a new bubble
    io.to(`group:${groupId}`).emit('message:new', result.message);

    // Broadcast the interactive poll payload so the bubble can render the widget
    io.to(`group:${groupId}`).emit('poll:created', {
      groupId,
      messageId: result.message.id,
      poll:      result.poll,
    });

    logger.info('Poll created', { pollId: result.poll.id, groupId, userId: socket.userId });

    callback?.({ ok: true, messageId: result.message.id, pollId: result.poll.id });
  } catch (err) {
    logger.warn('poll:create error', { userId: socket.userId, groupId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code ?? 'ERROR' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// poll:vote
// ─────────────────────────────────────────────────────────────────────────────
async function handleVote(socket, io, data, callback) {
  const { groupId, pollId, optionIds } = data || {};

  if (!groupId)                               return callback?.({ ok: false, error: 'groupId is required' });
  if (!pollId)                                return callback?.({ ok: false, error: 'pollId is required' });
  if (!Array.isArray(optionIds) || !optionIds.length) {
    return callback?.({ ok: false, error: 'optionIds must be a non-empty array' });
  }

  try {
    await membershipService.assertMembership(groupId, socket.userId);

    const poll = await pollService.getPoll(pollId);
    if (!poll)          return callback?.({ ok: false, error: 'Poll not found',                      code: 'NOT_FOUND'  });
    if (poll.is_closed) return callback?.({ ok: false, error: 'This poll is closed',                 code: 'POLL_CLOSED' });
    if (String(poll.chat_group_id) !== String(groupId)) {
      return callback?.({ ok: false, error: 'Poll does not belong to this group', code: 'FORBIDDEN' });
    }

    const updatedPoll = await pollService.vote({
      pollId,
      userId:    socket.userId,
      optionIds,
    });

    io.to(`group:${groupId}`).emit('poll:updated', {
      groupId,
      messageId: poll.message_id,
      poll:      updatedPoll,
    });

    logger.info('Poll vote cast', { pollId, userId: socket.userId, optionIds });

    callback?.({ ok: true, poll: updatedPoll });
  } catch (err) {
    logger.warn('poll:vote error', { userId: socket.userId, pollId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code ?? 'ERROR' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// poll:retract
// ─────────────────────────────────────────────────────────────────────────────
async function handleRetract(socket, io, data, callback) {
  const { groupId, pollId, optionId = null } = data || {};

  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });
  if (!pollId)  return callback?.({ ok: false, error: 'pollId is required' });

  try {
    await membershipService.assertMembership(groupId, socket.userId);

    const poll = await pollService.getPoll(pollId);
    if (!poll)          return callback?.({ ok: false, error: 'Poll not found',      code: 'NOT_FOUND'   });
    if (poll.is_closed) return callback?.({ ok: false, error: 'This poll is closed', code: 'POLL_CLOSED' });

    const updatedPoll = await pollService.retract({
      pollId,
      userId:   socket.userId,
      optionId,
    });

    io.to(`group:${groupId}`).emit('poll:updated', {
      groupId,
      messageId: poll.message_id,
      poll:      updatedPoll,
    });

    logger.info('Poll vote retracted', { pollId, userId: socket.userId, optionId });

    callback?.({ ok: true, poll: updatedPoll });
  } catch (err) {
    logger.warn('poll:retract error', { userId: socket.userId, pollId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code ?? 'ERROR' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// poll:close
// ─────────────────────────────────────────────────────────────────────────────
async function handleClose(socket, io, data, callback) {
  const { groupId, pollId } = data || {};

  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });
  if (!pollId)  return callback?.({ ok: false, error: 'pollId is required' });

  try {
    const membership = await membershipService.assertMembership(groupId, socket.userId);

    if (!membershipService.isTeacherOrAdmin(membership)) {
      return callback?.({ ok: false, error: 'Only teachers can close polls', code: 'FORBIDDEN' });
    }

    const poll = await pollService.getPoll(pollId);
    if (!poll) return callback?.({ ok: false, error: 'Poll not found', code: 'NOT_FOUND' });

    if (poll.is_closed) {
      return callback?.({ ok: false, error: 'Poll is already closed', code: 'ALREADY_CLOSED' });
    }

    const closedPoll = await pollService.close({ pollId, closerId: socket.userId });

    io.to(`group:${groupId}`).emit('poll:closed', {
      groupId,
      messageId: poll.message_id,
      poll:      closedPoll,
    });

    logger.info('Poll closed', { pollId, groupId, userId: socket.userId });

    callback?.({ ok: true, poll: closedPoll });
  } catch (err) {
    logger.warn('poll:close error', { userId: socket.userId, pollId, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code ?? 'ERROR' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────────────────

function register(socket, io) {
  socket.on('poll:create',  (data, cb) => handleCreate(socket, io, data, cb));
  socket.on('poll:vote',    (data, cb) => handleVote(socket, io, data, cb));
  socket.on('poll:retract', (data, cb) => handleRetract(socket, io, data, cb));
  socket.on('poll:close',   (data, cb) => handleClose(socket, io, data, cb));
}

module.exports = { register };