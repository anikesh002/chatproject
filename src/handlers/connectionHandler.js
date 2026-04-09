'use strict';

const presenceService   = require('../services/presenceService');
const typingService     = require('../services/typingService');
const membershipService = require('../services/membershipService');
const messageService    = require('../services/messageService');
const logger            = require('../utils/logger');

/**
 * ConnectionHandler
 *
 * Manages the lifecycle of a single Socket.IO connection:
 *   connect → join groups → messaging → disconnect
 *
 * Each socket stores its active groups in socket.activeGroups (Set)
 * so disconnect cleanup knows which rooms to leave.
 *
 * assertMembership vs assertMembershipReadOnly:
 *   group:join   → assertMembership      (active groups only — joining is a write/presence action)
 *   presence:get → assertMembershipReadOnly (viewing online members is valid on archived groups)
 *
 * CHANGES:
 *   - handleGroupJoin now emits 'presence:joined' back to the joining socket
 *     in addition to broadcasting to the rest of the room, so the joining
 *     user sees themselves as online in their own member list.
 */

/**
 * Handle 'group:join' — validate membership, join room, emit presence.
 *
 * Client emits:
 *   socket.emit('group:join', { groupId }, callback)
 *
 * Server emits to room (including joining socket):
 *   'presence:joined' → { groupId, user: { id, name, role } }
 *
 * ACK includes onlineMembers so the client can seed its online list
 * immediately without waiting for incremental presence:joined events.
 */
async function handleGroupJoin(socket, io, { groupId }, callback) {
  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });

  try {
    // assertMembership — group must be active to join
    const membership = await membershipService.assertMembership(groupId, socket.userId);

    const room = `group:${groupId}`;
    await socket.join(room);
    socket.activeGroups.add(Number(groupId));

    await presenceService.userJoinedGroup(
      groupId,
      socket.userId,
      socket.id,
      socket.userName,
      membership.role
    );

    const unreadCount = await messageService.getUnreadCount(groupId, socket.userId);

    // Broadcast to everyone else in the room that this user came online
    socket.to(room).emit('presence:joined', {
      groupId,
      user: { id: socket.userId, name: socket.userName, role: membership.role },
    });

    // ── FIX: also emit back to the joining socket itself ──────────────────
    // socket.to(room) excludes the sender, so the joining user never receives
    // their own presence:joined event and therefore never appears as "online"
    // in their own member list. Emitting directly to socket fixes this.
    socket.emit('presence:joined', {
      groupId,
      user: { id: socket.userId, name: socket.userName, role: membership.role },
    });

    // Fetch full online member list AFTER registering self so it includes
    // the joining user. Returned in ACK so the client can seed state
    // immediately instead of waiting for incremental events.
    const onlineMembers = await presenceService.getGroupPresence(groupId);

    logger.info('User joined group', { userId: socket.userId, groupId, room });

    callback?.({
      ok:           true,
      groupId,
      role:         membership.role,
      isMuted:      membershipService.isMutedNow(membership),
      mutedUntil:   membership.mutedUntil,
      unreadCount,
      onlineMembers,
    });
  } catch (err) {
    logger.warn('group:join failed', { userId: socket.userId, groupId, code: err.code, message: err.message });
    callback?.({ ok: false, error: err.message, code: err.code });
  }
}

/**
 * Handle 'group:leave' — leave room, clear presence.
 */
async function handleGroupLeave(socket, io, { groupId }, callback) {
  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });

  const room = `group:${groupId}`;
  await socket.leave(room);
  socket.activeGroups.delete(Number(groupId));

  await presenceService.userLeft(socket.id, socket.userId, [groupId]);
  await typingService.stopTyping(groupId, socket.userId);

  socket.to(room).emit('presence:left', {
    groupId,
    user: { id: socket.userId, name: socket.userName },
  });

  logger.info('User left group', { userId: socket.userId, groupId });
  callback?.({ ok: true });
}

/**
 * Handle 'heartbeat' — refresh presence TTLs.
 * Client should send every ~60 seconds.
 */
async function handleHeartbeat(socket, callback) {
  const groupIds = [...socket.activeGroups];
  await presenceService.refreshPresence(socket.userId, groupIds);
  callback?.({ ok: true, ts: Date.now() });
}

/**
 * Handle 'presence:get' — get online members of a group.
 *
 * Uses assertMembershipReadOnly — viewing who's online is valid
 * even for archived groups (e.g. browsing old batch history).
 */
async function handlePresenceGet(socket, { groupId }, callback) {
  if (!groupId) return callback?.({ ok: false, error: 'groupId is required' });

  try {
    // assertMembershipReadOnly — read-only, valid on archived groups
    await membershipService.assertMembershipReadOnly(groupId, socket.userId);
    const members = await presenceService.getGroupPresence(groupId);
    callback?.({ ok: true, groupId, members });
  } catch (err) {
    callback?.({ ok: false, error: err.message });
  }
}

/**
 * Handle socket disconnect — clean up all rooms, presence, typing.
 */
async function handleDisconnect(socket, io, reason) {
  const groupIds = [...socket.activeGroups];

  logger.info('Socket disconnected', {
    socketId:   socket.id,
    userId:     socket.userId,
    reason,
    groupCount: groupIds.length,
  });

  try {
    await presenceService.userLeft(socket.id, socket.userId, groupIds);
    await typingService.clearUserTyping(socket.userId, groupIds);

    for (const groupId of groupIds) {
      socket.to(`group:${groupId}`).emit('presence:left', {
        groupId,
        user: { id: socket.userId, name: socket.userName },
      });
    }
  } catch (err) {
    logger.error('Disconnect cleanup error', { userId: socket.userId, message: err.message });
  }
}

/**
 * Register all connection-level event handlers on a socket.
 * Called once per authenticated connection from server.js.
 */
function register(socket, io) {
  socket.activeGroups = new Set();

  socket.on('group:join',   (data, cb) => handleGroupJoin(socket, io, data, cb));
  socket.on('group:leave',  (data, cb) => handleGroupLeave(socket, io, data, cb));
  socket.on('heartbeat',    (cb)       => handleHeartbeat(socket, cb));
  socket.on('presence:get', (data, cb) => handlePresenceGet(socket, data, cb));
  socket.on('disconnect',   (reason)   => handleDisconnect(socket, io, reason));
}

module.exports = { register };