/** Typed failures for the intelligence subsystem. */

export class IntelligenceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IntelligenceError';
    this.code = code;
    this.details = details;
  }
}

/** Invalid caller input (bad request shape, unknown domain, malformed prices). */
export class IntelligenceInputError extends IntelligenceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTEL_INPUT', message, details);
    this.name = 'IntelligenceInputError';
  }
}

/** A read or index request escaped the configured document roots. */
export class IntelligenceSecurityError extends IntelligenceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTEL_SECURITY', message, details);
    this.name = 'IntelligenceSecurityError';
  }
}

/** A persisted store is unreadable. Fail closed instead of resetting data. */
export class StoreCorruptionError extends IntelligenceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTEL_STORE_CORRUPT', message, details);
    this.name = 'StoreCorruptionError';
  }
}

/** The audit chain is broken or the tip entry is unreadable. */
export class AuditIntegrityError extends IntelligenceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTEL_AUDIT_BROKEN', message, details);
    this.name = 'AuditIntegrityError';
  }
}
