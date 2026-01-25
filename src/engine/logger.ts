import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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

export class Logger {
  private logs: LogEntry[] = [];
  private logFilePath?: string;
  private latestLogPath?: string;

  constructor(options?: LoggerOptions) {
    this.logFilePath = options?.logFilePath;
    this.latestLogPath = options?.latestLogPath;
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

    const metaStr = metadata ? ` ${JSON.stringify(metadata)}` : '';

    const line = `[${entry.timestamp}] [${level}] ${message}${metaStr}`;
    console.log(line);

    if (this.logFilePath || this.latestLogPath) {
      try {
        const write = (targetPath: string) => {
          mkdirSync(dirname(targetPath), { recursive: true });
          appendFileSync(targetPath, `${line}\n`, 'utf-8');
        };

        if (this.logFilePath) write(this.logFilePath);
        if (this.latestLogPath) write(this.latestLogPath);
      } catch {
        // Do not fail the run if logging to file fails.
      }
    }
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
