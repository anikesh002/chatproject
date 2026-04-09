'use strict';

const { query, execute } = require('../config/db');
const logger             = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Message write
// ─────────────────────────────────────────────────────────────────────────────

async function createMessage({ groupId, senderId, type, text, replyToId = null }) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const result = await execute(
    `INSERT INTO chat_messages
       (chat_group_id, sender_id, type, text, reply_to_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [groupId, senderId, type, text || null, replyToId, now, now]
  );

  execute(
    'UPDATE chat_groups SET last_message_at = ? WHERE id = ?',
    [now, groupId]
  ).catch((e) => logger.warn('Failed to touch last_message_at', { message: e.message }));

  return {
    id:        result.insertId,
    groupId,
    senderId,
    type,
    text:      text || null,
    replyToId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a system message with no sender.
 *
 * Usage:
 *   const msg = await createSystemMessage(groupId, 'Ravi Kumar joined the group.');
 */
async function createSystemMessage(groupId, text) {
  return createMessage({ groupId, senderId: null, type: 'system', text });
}

/**
 * Fetch a single message with sender, replyTo, and attachments.
 * Uses LEFT JOIN so system messages (sender_id = null) are included.
 */
async function getMessageWithDetails(messageId) {
  const rows = await query(
    `SELECT
       m.id, m.chat_group_id AS groupId, m.type, m.text,
       m.reply_to_id AS replyToId, m.edited_at AS editedAt,
       m.created_at AS createdAt,
       s.id AS senderId, s.name AS senderName,
       r.id AS replyMsgId, r.text AS replyText,
       rs.id AS replySenderId, rs.name AS replySenderName
     FROM chat_messages m
     LEFT JOIN users s         ON s.id  = m.sender_id
     LEFT JOIN chat_messages r ON r.id  = m.reply_to_id
     LEFT JOIN users rs        ON rs.id = r.sender_id
     WHERE m.id = ? AND m.deleted_at IS NULL`,
    [messageId]
  );

  if (!rows.length) return null;
  const row = rows[0];

  const attachments = await query(
    `SELECT id, type, name, url, mime_type AS mimeType, size_bytes AS sizeBytes
     FROM chat_message_attachments
     WHERE chat_message_id = ?`,
    [messageId]
  );

  return {
    id:          row.id,
    groupId:     row.groupId,
    type:        row.type,
    text:        row.text,
    editedAt:    row.editedAt,
    createdAt:   row.createdAt,
    sender:      row.senderId ? { id: row.senderId, name: row.senderName } : null,
    replyTo:     row.replyMsgId
      ? { id: row.replyMsgId, text: row.replyText, sender: { id: row.replySenderId, name: row.replySenderName } }
      : null,
    attachments,
    reactions: [],
    reads:     [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching messages (user-scoped with visibility filters)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch paginated messages for a group scoped to a specific user.
 *
 * Applies three visibility filters:
 *   1. deleted_at IS NULL              — not deleted for everyone
 *   2. no chat_message_deletions row   — not deleted for me
 *   3. created_at > clear watermark    — not before user's "clear chat"
 *
 * Usage:
 *   const messages = await getMessagesForUser(groupId, userId, { before: 200, limit: 30 });
 */
async function getMessagesForUser(groupId, userId, { before = null, limit = 30 } = {}) {
  const watermark = await getClearWatermark(groupId, userId);

  const params = [groupId, userId];
  let watermarkClause = '';
  let cursorClause    = '';

  if (watermark) {
    watermarkClause = 'AND m.created_at > ?';
    params.push(watermark);
  }

  if (before) {
    cursorClause = 'AND m.id < ?';
    params.push(before);
  }

  params.push(limit);

  const rows = await query(
    `SELECT
       m.id, m.chat_group_id AS groupId, m.type, m.text,
       m.reply_to_id AS replyToId, m.edited_at AS editedAt,
       m.created_at AS createdAt,
       s.id AS senderId, s.name AS senderName,
       r.id AS replyMsgId, r.text AS replyText,
       rs.id AS replySenderId, rs.name AS replySenderName
     FROM chat_messages m
     LEFT JOIN users s         ON s.id  = m.sender_id
     LEFT JOIN chat_messages r ON r.id  = m.reply_to_id
     LEFT JOIN users rs        ON rs.id = r.sender_id
     WHERE m.chat_group_id = ?
       AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM chat_message_deletions d
         WHERE d.chat_message_id = m.id
           AND d.user_id = ?
       )
       ${watermarkClause}
       ${cursorClause}
     ORDER BY m.id DESC
     LIMIT ?`,
    params
  );

  if (!rows.length) return [];

  // Attach attachments in bulk
  const messageIds   = rows.map((r) => r.id);
  const placeholders = messageIds.map(() => '?').join(',');
  const attachments  = await query(
    `SELECT id, chat_message_id AS messageId, type, name, url,
            mime_type AS mimeType, size_bytes AS sizeBytes
     FROM chat_message_attachments
     WHERE chat_message_id IN (${placeholders})`,
    messageIds
  );

  const attachmentsMap = {};
  for (const att of attachments) {
    if (!attachmentsMap[att.messageId]) attachmentsMap[att.messageId] = [];
    attachmentsMap[att.messageId].push(att);
  }

  return rows.map((row) => ({
    id:          row.id,
    groupId:     row.groupId,
    type:        row.type,
    text:        row.text,
    editedAt:    row.editedAt,
    createdAt:   row.createdAt,
    sender:      row.senderId ? { id: row.senderId, name: row.senderName } : null,
    replyTo:     row.replyMsgId
      ? { id: row.replyMsgId, text: row.replyText, sender: { id: row.replySenderId, name: row.replySenderName } }
      : null,
    attachments: attachmentsMap[row.id] || [],
    reactions:   [],
    reads:       [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Message edit / delete
// ─────────────────────────────────────────────────────────────────────────────

async function editMessage(messageId, newText) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await execute(
    'UPDATE chat_messages SET text = ?, edited_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    [newText, now, now, messageId]
  );
  return { messageId, text: newText, editedAt: now };
}

/**
 * Soft-delete a message for everyone.
 * Returns true if deleted, false if already deleted.
 */
async function deleteMessage(messageId) {
  const now    = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const result = await execute(
    'UPDATE chat_messages SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    [now, now, messageId]
  );
  return result.affectedRows > 0;
}

/**
 * Get minimal message metadata for permission checks.
 * Includes createdAt for time-window enforcement on deleteForEveryone.
 */
async function getMessageMeta(messageId) {
  const rows = await query(
    `SELECT
       id,
       sender_id     AS senderId,
       type,
       chat_group_id AS groupId,
       created_at    AS createdAt
     FROM chat_messages
     WHERE id = ? AND deleted_at IS NULL`,
    [messageId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete for me / Clear chat
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hide a single message for one user only.
 * Idempotent — INSERT IGNORE skips if already deleted.
 *
 * Usage:
 *   await deleteForMe(messageId, userId);
 */
async function deleteForMe(messageId, userId) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await execute(
    `INSERT IGNORE INTO chat_message_deletions
       (chat_message_id, user_id, deleted_at)
     VALUES (?, ?, ?)`,
    [messageId, userId, now]
  );
}

/**
 * Hide multiple messages at once for one user.
 * Idempotent — INSERT IGNORE skips duplicates.
 *
 * Usage:
 *   await bulkDeleteForMe([1, 2, 3], userId);
 */
async function bulkDeleteForMe(messageIds, userId) {
  if (!messageIds.length) return 0;

  const now    = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const values = messageIds.map((id) => `(${Number(id)}, ${Number(userId)}, '${now}')`).join(', ');

  await execute(
    `INSERT IGNORE INTO chat_message_deletions
       (chat_message_id, user_id, deleted_at)
     VALUES ${values}`
  );

  return messageIds.length;
}

/**
 * Record a "clear chat" watermark for a user in a group.
 * All messages created before now() will be hidden for this user.
 * Returns the cleared_at timestamp string.
 *
 * Usage:
 *   const clearedAt = await clearChatForUser(groupId, userId);
 */
async function clearChatForUser(groupId, userId) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  await execute(
    `INSERT INTO chat_clear_history
       (chat_group_id, user_id, cleared_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [groupId, userId, now, now, now]
  );

  return now;
}

/**
 * Get the latest clear watermark for a user in a group.
 * Returns null if the user has never cleared this chat.
 *
 * Usage:
 *   const watermark = await getClearWatermark(groupId, userId);
 */
async function getClearWatermark(groupId, userId) {
  const rows = await query(
    `SELECT cleared_at AS clearedAt
     FROM chat_clear_history
     WHERE chat_group_id = ? AND user_id = ?
     ORDER BY cleared_at DESC
     LIMIT 1`,
    [groupId, userId]
  );
  return rows[0]?.clearedAt ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactions
// ─────────────────────────────────────────────────────────────────────────────

async function toggleReaction(messageId, userId, emoji) {
  const existing = await query(
    'SELECT id FROM chat_message_reactions WHERE chat_message_id = ? AND user_id = ? AND emoji = ?',
    [messageId, userId, emoji]
  );

  let action;
  if (existing.length) {
    await execute('DELETE FROM chat_message_reactions WHERE id = ?', [existing[0].id]);
    action = 'removed';
  } else {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await execute(
      'INSERT INTO chat_message_reactions (chat_message_id, user_id, emoji, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [messageId, userId, emoji, now, now]
    );
    action = 'added';
  }

  const reactions = await getGroupedReactions(messageId);
  return { action, emoji, reactions };
}

async function getGroupedReactions(messageId) {
  const rows = await query(
    `SELECT r.emoji, r.user_id AS userId, u.name AS userName
     FROM chat_message_reactions r
     INNER JOIN users u ON u.id = r.user_id
     WHERE r.chat_message_id = ?`,
    [messageId]
  );

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.emoji]) grouped[row.emoji] = { count: 0, users: [] };
    grouped[row.emoji].count++;
    grouped[row.emoji].users.push({ id: row.userId, name: row.userName });
  }
  return grouped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read receipts
// ─────────────────────────────────────────────────────────────────────────────

async function markAllReadUpTo(groupId, userId, lastMessageId) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const unread = await query(
    `SELECT id FROM chat_messages
     WHERE chat_group_id = ?
       AND id <= ?
       AND (sender_id != ? OR sender_id IS NULL)
       AND deleted_at IS NULL
       AND id NOT IN (
         SELECT chat_message_id FROM chat_message_reads WHERE user_id = ?
       )`,
    [groupId, lastMessageId, userId, userId]
  );

  if (unread.length) {
    const values = unread.map((r) => `(${r.id}, ${userId}, '${now}')`).join(', ');
    await execute(
      `INSERT IGNORE INTO chat_message_reads (chat_message_id, user_id, read_at) VALUES ${values}`
    );
  }

  await execute(
    `UPDATE chat_group_members
     SET last_read_message_id = ?, last_seen_at = ?
     WHERE chat_group_id = ? AND user_id = ?`,
    [lastMessageId, now, groupId, userId]
  );

  return { markedCount: unread.length, lastMessageId };
}

async function getUnreadCount(groupId, userId) {
  const rows = await query(
    `SELECT COUNT(*) AS cnt
     FROM chat_messages m
     WHERE m.chat_group_id = ?
       AND m.sender_id != ?
       AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM chat_message_reads r
         WHERE r.chat_message_id = m.id AND r.user_id = ?
       )`,
    [groupId, userId, userId]
  );
  return rows[0]?.cnt ?? 0;
}

async function getReadersForMessage(messageId) {
  const rows = await query(
    `SELECT u.id, u.name, r.read_at AS readAt
     FROM chat_message_reads r
     INNER JOIN users u ON u.id = r.user_id
     WHERE r.chat_message_id = ?
     ORDER BY r.read_at ASC`,
    [messageId]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Send
  createMessage,
  createSystemMessage,

  // Fetch
  getMessageWithDetails,
  getMessagesForUser,
  getMessageMeta,

  // Edit / Delete for everyone
  editMessage,
  deleteMessage,

  // Delete for me / Clear chat
  deleteForMe,
  bulkDeleteForMe,
  clearChatForUser,
  getClearWatermark,

  // Reactions
  toggleReaction,
  getGroupedReactions,

  // Read receipts
  markAllReadUpTo,
  getUnreadCount,
  getReadersForMessage,
};