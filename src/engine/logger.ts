import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface LoggerOptions {
  /**
   * If provided, every log line will also be appended to this file.
   * (Console logging still happens.)
   */
  logFilePath?: string;
  /**
   * If provided, we also maintain a stable "latest" pointer to the newest run.
   */
  latestLogPath?: string;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function cleanupOldLogs(logDir: string, retentionDays: number): void {
  try {
    const now = Date.now();
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    const entries = readdirSync(logDir);

    for (const name of entries) {
      const full = resolve(logDir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > maxAgeMs) {
        try {
          unlinkSync(full);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

export class Logger {
  private logs: LogEntry[] = [];
  private logFilePath?: string;
  private latestLogPath?: string;
  private baseLogger: winston.Logger;

  constructor(options?: LoggerOptions) {
    this.logFilePath = options?.logFilePath;
    this.latestLogPath = options?.latestLogPath;

    const logDir = resolve('./output/logs');
    mkdirSync(logDir, { recursive: true });

    const retentionDays = Number(process.env.LOG_RETENTION_DAYS || 15);
    cleanupOldLogs(logDir, retentionDays);

    const toLine = winston.format.printf((info: winston.Logform.TransformableInfo) => {
      const meta = (info as any).metadata ? ` ${safeStringify((info as any).metadata)}` : '';
      return `[${info.timestamp}] [${String(info.level).toUpperCase()}] ${info.message}${meta}`;
    });

    const transports: winston.transport[] = [
      new winston.transports.Console({}),
      new DailyRotateFile({
        filename: resolve(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: `${retentionDays}d`,
        zippedArchive: false,
      }) as unknown as winston.transport,
    ];

    if (this.logFilePath) {
      mkdirSync(dirname(this.logFilePath), { recursive: true });
      transports.push(
        new winston.transports.File({
          filename: this.logFilePath,
        })
      );
    }

    if (this.latestLogPath) {
      mkdirSync(dirname(this.latestLogPath), { recursive: true });
      transports.push(
        new winston.transports.File({
          filename: this.latestLogPath,
          options: { flags: 'w' },
        })
      );
    }

    this.baseLogger = winston.createLogger({
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
      format: winston.format.combine(
        winston.format.timestamp(),
        toLine
      ),
      transports,
    });
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      message,
      metadata,
    };

    this.logs.push(entry);
    if (this.logs.length > 2000) {
      this.logs.shift();
    }

    const winstonLevel = level === LogLevel.DEBUG
      ? 'debug'
      : level === LogLevel.INFO
        ? 'info'
        : level === LogLevel.WARN
          ? 'warn'
          : 'error';

    this.baseLogger.log(winstonLevel, message, { metadata });
  }

  debug(message: string, metadata?: Record<string, unknown>) {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>) {
    this.log(LogLevel.INFO, message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>) {
    this.log(LogLevel.WARN, message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>) {
    this.log(LogLevel.ERROR, message, metadata);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }
}
