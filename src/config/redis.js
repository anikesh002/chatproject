'use strict';

const Redis  = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

const REDIS_OPTIONS = {
  host:            config.REDIS.host,
  port:            config.REDIS.port,
  password:        config.REDIS.password,
  db:              config.REDIS.db,
  lazyConnect:     false,
  // Reconnect strategy: exponential back-off, max 30s
  retryStrategy(times) {
    const delay = Math.min(times * 100, 30000);
    logger.warn(`Redis reconnect attempt #${times}, delay ${delay}ms`);
    return delay;
  },
  enableReadyCheck:          true,
  maxRetriesPerRequest:      3,
  enableAutoPipelining:      true,
};

// ── Command client (GET, SET, HSET, ZADD …) ──────────────────────────
const redisClient = new Redis(REDIS_OPTIONS);
redisClient.on('connect', () => logger.info('Redis (command): connected'));
redisClient.on('error',   (e) => logger.error('Redis (command) error', { message: e.message }));

// ── Pub/Sub subscriber (must be a separate connection) ────────────────
const redisSub = new Redis(REDIS_OPTIONS);
redisSub.on('connect', () => logger.info('Redis (sub): connected'));
redisSub.on('error',   (e) => logger.error('Redis (sub) error', { message: e.message }));

// ── Publisher (dedicated client keeps adapter pattern clean) ──────────
const redisPub = new Redis(REDIS_OPTIONS);
redisPub.on('connect', () => logger.info('Redis (pub): connected'));
redisPub.on('error',   (e) => logger.error('Redis (pub) error', { message: e.message }));

module.exports = { redisClient, redisSub, redisPub };