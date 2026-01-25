export enum ErrorCode {
  SESSION_INVALID = 'SESSION_INVALID',
  CAPTCHA_DETECTED = 'CAPTCHA_DETECTED',
  OTP_REQUIRED = 'OTP_REQUIRED',
  LOGIN_REDIRECT = 'LOGIN_REDIRECT',
  EDITOR_NOT_READY = 'EDITOR_NOT_READY',
  PUBLISH_FAILED = 'PUBLISH_FAILED',
  CONFIG_INVALID = 'CONFIG_INVALID',
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  ARTICLE_NOT_FOUND = 'ARTICLE_NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN'
}

export class PublisherError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PublisherError';
  }
}

export class SessionError extends PublisherError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.SESSION_INVALID, message, metadata);
    this.name = 'SessionError';
  }
}

export class CaptchaError extends PublisherError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.CAPTCHA_DETECTED, message, metadata);
    this.name = 'CaptchaError';
  }
}

export class EditorError extends PublisherError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.EDITOR_NOT_READY, message, metadata);
    this.name = 'EditorError';
  }
}

export class PublishError extends PublisherError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(ErrorCode.PUBLISH_FAILED, message, metadata);
    this.name = 'PublishError';
  }
}
