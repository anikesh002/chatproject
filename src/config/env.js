'use strict';

require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, defaultVal) {
  return process.env[key] || defaultVal;
}

function optionalInt(key, defaultVal) {
  const val = process.env[key];
  return val ? parseInt(val, 10) : defaultVal;
}

module.exports = {
  NODE_ENV: optional('NODE_ENV', 'production'),
  PORT: optionalInt('PORT', 3001),

  ALLOWED_ORIGINS: optional('ALLOWED_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),

  DB: {
    host:     optional('DB_HOST', '127.0.0.1'),
    port:     optionalInt('DB_PORT', 3306),
    database: optional('DB_DATABASE', 'lms_db'),
    user:     optional('DB_USERNAME', 'root'),
    password: optional('DB_PASSWORD', ''),
    poolMin:  optionalInt('DB_POOL_MIN', 2),
    poolMax:  optionalInt('DB_POOL_MAX', 20),
  },

  REDIS: {
    host:     optional('REDIS_HOST', '127.0.0.1'),
    port:     optionalInt('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', '') || undefined,
    db:       optionalInt('REDIS_DB', 0),
  },

  TTL: {
    token:      optionalInt('TOKEN_CACHE_TTL', 300),
    presence:   optionalInt('PRESENCE_TTL', 120),
    typing:     optionalInt('TYPING_TTL', 5),
    membership: optionalInt('MEMBERSHIP_CACHE_TTL', 600),
  },

  RATE_LIMIT: {
    messages:      optionalInt('RATE_LIMIT_MESSAGES', 30),
    windowSeconds: optionalInt('RATE_LIMIT_WINDOW_SECONDS', 60),
  },
};