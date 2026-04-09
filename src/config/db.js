'use strict';

const mysql  = require('mysql2/promise');
const config = require('./env');
const logger = require('../utils/logger');

let pool;

/**
 * Returns (and lazily creates) the shared MySQL connection pool.
 * The pool is shared between the auth middleware, message handler, etc.
 *
 * Node.js reads from the same MySQL database as Laravel.
 * It never touches Laravel internals — only raw table reads/writes.
 */
function getPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host:               config.DB.host,
    port:               config.DB.port,
    database:           config.DB.database,
    user:               config.DB.user,
    password:           config.DB.password,
    waitForConnections: true,
    connectionLimit:    config.DB.poolMax,
    queueLimit:         0,
    // Keep connections alive through idle periods
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000,
    timezone:           'Z', // UTC — matches Laravel's default
  });

  pool.on('connection', () => logger.debug('MySQL: new connection acquired'));

  logger.info('MySQL pool created', {
    host: config.DB.host,
    port: config.DB.port,
    db:   config.DB.database,
  });

  return pool;
}

/**
 * Execute a SELECT query. Returns array of rows.
 * @param {string} sql
 * @param {any[]}  params
 */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/**
 * Execute a write query (INSERT / UPDATE / DELETE).
 * Returns the ResultSetHeader (insertId, affectedRows, etc.)
 */
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

module.exports = { getPool, query, execute };