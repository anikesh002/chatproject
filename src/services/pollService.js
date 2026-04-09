'use strict';

const { query, execute } = require('../config/db');
const logger             = require('../utils/logger');

/**
 * pollService.js
 *
 * MySQL DB layer for chat polls. Mirrors the patterns in messageService.js:
 * raw SQL via the shared query/execute helpers, no ORM.
 *
 * All writes that need multiple INSERTs use manual transactions.
 *
 * Public API:
 *   create({ groupId, creatorId, question, options, allowMultiple, anonymous })
 *   getPoll(pollId)
 *   vote({ pollId, userId, optionIds })
 *   retract({ pollId, userId, optionId? })
 *   close({ pollId, closerId })
 *   getResult(pollId, currentUserId?)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Build the full result payload for a poll.
 * Matches the shape expected by the frontend PollBubble component.
 */
async function buildResultPayload(pollId, currentUserId = null) {
  // Core poll row
  const polls = await query(
    `SELECT
       p.id, p.message_id, p.chat_group_id, p.created_by,
       p.question, p.allow_multiple, p.anonymous,
       p.closed_at, p.created_at
     FROM chat_polls p
     WHERE p.id = ?`,
    [pollId]
  );

  if (!polls.length) return null;
  const poll = polls[0];

  // Options with vote counts
  const options = await query(
    `SELECT
       o.id, o.text, o.sort_order,
       COUNT(v.id) AS vote_count
     FROM chat_poll_options o
     LEFT JOIN chat_poll_votes v ON v.option_id = o.id
     WHERE o.poll_id = ?
     GROUP BY o.id
     ORDER BY o.sort_order ASC`,
    [pollId]
  );

  // Voter ids per option (only for non-anonymous polls)
  let voterMap = {};
  if (!poll.anonymous) {
    const voters = await query(
      `SELECT v.option_id, v.user_id
       FROM chat_poll_votes v
       INNER JOIN chat_poll_options o ON o.id = v.option_id
       WHERE o.poll_id = ?`,
      [pollId]
    );
    for (const row of voters) {
      if (!voterMap[row.option_id]) voterMap[row.option_id] = [];
      voterMap[row.option_id].push(String(row.user_id));
    }
  }

  // Which options has the current user voted for?
  let userVotedOptionIds = [];
  if (currentUserId) {
    const userVotes = await query(
      `SELECT v.option_id
       FROM chat_poll_votes v
       INNER JOIN chat_poll_options o ON o.id = v.option_id
       WHERE o.poll_id = ? AND v.user_id = ?`,
      [pollId, currentUserId]
    );
    userVotedOptionIds = userVotes.map((r) => String(r.option_id));
  }

  const totalVotes = options.reduce((sum, o) => sum + Number(o.vote_count), 0);

  return {
    id:           poll.id,
    message_id:   poll.message_id,
    question:     poll.question,
    allow_multiple: !!poll.allow_multiple,
    anonymous:    !!poll.anonymous,
    is_closed:    poll.closed_at !== null,
    closed_at:    poll.closed_at ? new Date(poll.closed_at).toISOString() : null,
    total_votes:  totalVotes,
    options:      options.map((o) => ({
      id:         o.id,
      text:       o.text,
      sort_order: o.sort_order,
      vote_count: Number(o.vote_count),
      ...(!poll.anonymous ? { voter_ids: voterMap[o.id] || [] } : {}),
    })),
    user_voted_option_ids: userVotedOptionIds,
    created_at:   new Date(poll.created_at).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a poll and its linked chat_message row.
 *
 * Returns:
 *   {
 *     message: { id, groupId, type, text, sender, ... },  // for message:new broadcast
 *     poll:    PollResultPayload                           // for poll:created broadcast
 *   }
 */
async function create({ groupId, creatorId, question, options, allowMultiple, anonymous }) {
  const ts = now();

  // 1. Insert the chat_message row (type='poll', text=question for preview)
  const msgResult = await execute(
    `INSERT INTO chat_messages
       (chat_group_id, sender_id, type, text, created_at, updated_at)
     VALUES (?, ?, 'poll', ?, ?, ?)`,
    [groupId, creatorId, question, ts, ts]
  );
  const messageId = msgResult.insertId;

  // Touch group last_message_at
  execute(
    'UPDATE chat_groups SET last_message_at = ? WHERE id = ?',
    [ts, groupId]
  ).catch((e) => logger.warn('Failed to touch last_message_at', { message: e.message }));

  // 2. Insert the poll row
  const pollResult = await execute(
    `INSERT INTO chat_polls
       (message_id, chat_group_id, created_by, question, allow_multiple, anonymous, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, groupId, creatorId, question, allowMultiple ? 1 : 0, anonymous ? 1 : 0, ts, ts]
  );
  const pollId = pollResult.insertId;

  // 3. Insert options
  for (let i = 0; i < options.length; i++) {
    await execute(
      `INSERT INTO chat_poll_options (poll_id, text, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [pollId, options[i].trim(), i, ts, ts]
    );
  }

  // 4. Fetch sender for message:new broadcast
  const senders = await query('SELECT id, name FROM users WHERE id = ?', [creatorId]);
  const sender  = senders[0] ?? null;

  const message = {
    id:        messageId,
    groupId:   String(groupId),
    type:      'poll',
    text:      question,
    sender:    sender ? { id: sender.id, name: sender.name } : null,
    replyTo:   null,
    attachments: [],
    reactions:   [],
    reads:       [],
    isDeleted:   false,
    createdAt:   ts,
    updatedAt:   ts,
  };

  const poll = await buildResultPayload(pollId, creatorId);

  return { message, poll };
}

// ─────────────────────────────────────────────────────────────────────────────
// getPoll
// ─────────────────────────────────────────────────────────────────────────────

async function getPoll(pollId) {
  const rows = await query(
    `SELECT id, message_id, chat_group_id, created_by,
            question, allow_multiple, anonymous, closed_at
     FROM chat_polls WHERE id = ?`,
    [pollId]
  );
  if (!rows.length) return null;
  const p = rows[0];
  return {
    ...p,
    allow_multiple: !!p.allow_multiple,
    anonymous:      !!p.anonymous,
    is_closed:      p.closed_at !== null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// vote
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cast a vote. For single-choice polls, replaces any existing vote first.
 * Uses INSERT IGNORE to handle idempotent multi-choice votes.
 *
 * Returns the updated PollResultPayload.
 */
async function vote({ pollId, userId, optionIds }) {
  const ts = now();

  // Verify options belong to this poll
  const placeholders = optionIds.map(() => '?').join(',');
  const validOptions = await query(
    `SELECT id FROM chat_poll_options WHERE poll_id = ? AND id IN (${placeholders})`,
    [pollId, ...optionIds]
  );

  if (validOptions.length !== optionIds.length) {
    throw Object.assign(
      new Error('One or more option IDs do not belong to this poll.'),
      { code: 'INVALID_OPTION' }
    );
  }

  // Check if single-choice — delete existing vote before inserting
  const pollRows = await query(
    'SELECT allow_multiple FROM chat_polls WHERE id = ?',
    [pollId]
  );
  const allowMultiple = pollRows[0]?.allow_multiple;

  if (!allowMultiple) {
    await execute(
      'DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ?',
      [pollId, userId]
    );
  }

  for (const optionId of optionIds) {
    await execute(
      `INSERT IGNORE INTO chat_poll_votes (poll_id, option_id, user_id, voted_at)
       VALUES (?, ?, ?, ?)`,
      [pollId, optionId, userId, ts]
    );
  }

  return buildResultPayload(pollId, userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// retract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove vote(s). Pass optionId to retract a specific choice, or null for all.
 */
async function retract({ pollId, userId, optionId = null }) {
  if (optionId !== null) {
    await execute(
      'DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ? AND option_id = ?',
      [pollId, userId, optionId]
    );
  } else {
    await execute(
      'DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ?',
      [pollId, userId]
    );
  }

  return buildResultPayload(pollId, userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// close
// ─────────────────────────────────────────────────────────────────────────────

async function close({ pollId, closerId }) {
  const ts = now();
  await execute(
    'UPDATE chat_polls SET closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL',
    [ts, ts, pollId]
  );
  return buildResultPayload(pollId, closerId);
}

// ─────────────────────────────────────────────────────────────────────────────
// getResult
// ─────────────────────────────────────────────────────────────────────────────

async function getResult(pollId, currentUserId = null) {
  return buildResultPayload(pollId, currentUserId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  create,
  getPoll,
  vote,
  retract,
  close,
  getResult,
};