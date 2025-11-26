import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Winston Logger Configuration
 *
 * Provides structured logging with different transports based on environment
 */
export const loggerConfig = (env: string): WinstonModuleOptions => {
  const isDevelopment = env === 'development';
  const isProduction = env === 'production';

  // Common format for all transports
  const commonFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.metadata({
      fillExcept: ['message', 'level', 'timestamp', 'label'],
    }),
  );

  // Development format (pretty, colored)
  const developmentFormat = winston.format.combine(
    commonFormat,
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, metadata, stack }) => {
      let log = `${timestamp} [${level}] ${message}`;

      // Add metadata if present
      if (metadata && Object.keys(metadata).length > 0) {
        log += `\n${JSON.stringify(metadata, null, 2)}`;
      }

      // Add stack trace for errors
      if (stack) {
        log += `\n${stack}`;
      }

      return log;
    }),
  );

  // Production format (JSON)
  const productionFormat = winston.format.combine(
    commonFormat,
    winston.format.json(),
  );

  // Determine formats and transports based on environment
  const format = isDevelopment ? developmentFormat : productionFormat;

  const transports: winston.transport[] = [];

  // Console transport (all environments)
  transports.push(
    new winston.transports.Console({
      level: isDevelopment ? 'debug' : isProduction ? 'warn' : 'info',
      handleExceptions: true,
      handleRejections: true,
    }),
  );

  // File transports (staging and production)
  if (!isDevelopment) {
    // Error log file (daily rotation)
    transports.push(
      new DailyRotateFile({
        filename: 'logs/error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxSize: '20m',
        maxFiles: '30d',
        handleExceptions: true,
        handleRejections: true,
        zippedArchive: true,
      }),
    );

    // Combined log file (daily rotation)
    transports.push(
      new DailyRotateFile({
        filename: 'logs/combined-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        zippedArchive: true,
      }),
    );

    // Application log file (daily rotation)
    transports.push(
      new DailyRotateFile({
        filename: 'logs/app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'info',
        maxSize: '20m',
        maxFiles: '14d',
        zippedArchive: true,
      }),
    );
  }

  return {
    level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
    format,
    transports,
    exitOnError: false,
    silent: process.env.NODE_ENV === 'test',
  };
};

/**
 * Create logger instance
 */
export const createLogger = (env: string = 'development'): winston.Logger => {
  const config = loggerConfig(env);

  return winston.createLogger({
    level: config.level as string,
    format: config.format,
    transports: config.transports,
    exitOnError: config.exitOnError,
    silent: config.silent,
  });
};
