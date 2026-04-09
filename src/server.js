'use strict';

const http   = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const config  = require('./config/env');
const logger  = require('./utils/logger');
const { redisPub, redisSub } = require('./config/redis');
const { getPool }            = require('./config/db');

const { authenticateSocket } = require('./middleware/authenticate');

// ── Handlers ──────────────────────────────────────────────────────────────────
const connectionHandler = require('./handlers/connectionHandler');
const messageHandler    = require('./handlers/messageHandler');
const reactionHandler   = require('./handlers/reactionHandler');
const typingHandler     = require('./handlers/typingHandler');
const readHandler       = require('./handlers/readHandler');
const adminHandler      = require('./handlers/adminHandler');
const deletionHandler   = require('./handlers/DeletionHandler');
const pollHandler       = require('./handlers/PollHandler');

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'lms-chat', ts: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── Socket.IO server ──────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      config.ALLOWED_ORIGINS,
    methods:     ['GET', 'POST'],
    credentials: true,
  },

  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares:          true,
  },

  transports:          ['websocket', 'polling'],
  pingTimeout:         30000,
  pingInterval:        25000,
  upgradeTimeout:      10000,
  maxHttpBufferSize:   1e5,

  adapter: createAdapter(redisPub, redisSub),
});

// ── Authentication middleware ─────────────────────────────────────────────────
io.use(authenticateSocket);

// ── Per-connection handler ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info('New authenticated connection', {
    socketId:  socket.id,
    userId:    socket.userId,
    name:      socket.userName,
    transport: socket.conn.transport.name,
  });

  connectionHandler.register(socket, io);
  messageHandler.register(socket, io);
  reactionHandler.register(socket, io);
  typingHandler.register(socket, io);
  readHandler.register(socket, io);
  adminHandler.register(socket, io);
  deletionHandler.register(socket, io);
  pollHandler.register(socket, io);

  if (config.NODE_ENV !== 'production') {
    socket.onAny((event) => {
      logger.debug(`[socket] event: ${event}`, { socketId: socket.id });
    });
  }
});

// ── Engine error handling ─────────────────────────────────────────────────────
io.engine.on('connection_error', (err) => {
  logger.error('Socket.IO engine error', {
    code:    err.code,
    message: err.message,
    context: err.context,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves when an ioredis client reaches 'ready' state.
 * If it is already ready, resolves immediately.
 */
function waitForRedis(client, name) {
  return new Promise((resolve, reject) => {
    if (client.status === 'ready') {
      logger.info(`Redis (${name}): already ready`);
      return resolve();
    }

    const onReady = () => {
      cleanup();
      logger.info(`Redis (${name}): ready`);
      resolve();
    };

    const onError = (err) => {
      cleanup();
      reject(new Error(`Redis (${name}) failed to become ready: ${err.message}`));
    };

    const cleanup = () => {
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
    };

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  logger.info('Starting LMS Chat Server...');

  // 1. Warm up DB pool
  const pool = getPool();
  await pool.query('SELECT 1');
  logger.info('MySQL connection pool ready');

  // 2. Wait for Redis clients
  await Promise.all([
    waitForRedis(redisPub, 'pub'),
    waitForRedis(redisSub, 'sub'),
  ]);
  logger.info('Redis adapters ready');

  // 3. Start HTTP server
  await new Promise((resolve) => {
    httpServer.listen(config.PORT, '0.0.0.0', () => {
      logger.info(`LMS Chat Server running on port ${config.PORT}`, {
        env:     config.NODE_ENV,
        origins: config.ALLOWED_ORIGINS,
        host:    '0.0.0.0',
      });
      resolve();
    });
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`Received ${signal} — graceful shutdown initiated`);

  io.close(() => {
    logger.info('Socket.IO server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

start().catch((err) => {
  logger.error('Failed to start server', { message: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = { io, httpServer };