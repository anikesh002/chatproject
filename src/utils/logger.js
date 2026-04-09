'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, errors, json, colorize, simple } = format;

const isDev = process.env.NODE_ENV !== 'production';

const logger = createLogger({
  level: isDev ? 'debug' : 'info',
  format: combine(
    errors({ stack: true }),
    timestamp(),
    json()
  ),
  defaultMeta: { service: 'lms-chat' },
  transports: [
    // Always write errors to error.log
    new transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level:    'error',
      maxsize:  10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    // All logs to combined.log
    new transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize:  20 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
    }),
  ],
});

// Human-readable console output in dev
if (isDev) {
  logger.add(new transports.Console({
    format: combine(colorize(), simple()),
  }));
} else {
  // Production: structured JSON to stdout (captured by PM2 / systemd)
  logger.add(new transports.Console({ format: json() }));
}

module.exports = logger;