'use strict';
const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs-extra');

const logDir = path.dirname(process.env.LOG_FILE || '/tmp/tentacles.log');
fs.ensureDirSync(logDir);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${extras}`;
        })
      )
    }),
    new transports.File({
      filename: process.env.LOG_FILE || '/tmp/tentacles.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    })
  ]
});

module.exports = logger;
