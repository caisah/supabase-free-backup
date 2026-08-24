import { urlPassword } from './config.js';

/**
 * Secret-free logger used by every backup/restore script.
 *
 * - status/warning/error levels
 * - optional GitHub Actions workflow annotations (no color/animated output)
 * - redaction of registered secret values and database URLs
 * - never serializes the process environment
 *
 * Registered secrets must be at least 4 characters: shorter tokens would
 * over-redact common log text and are intentionally not registered.
 */

export function escapeAnnotation(message) {
  return String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export class Redactor {
  constructor(secrets = []) {
    this.secrets = new Set();
    for (const secret of secrets) this.addSecret(secret);
  }

  addSecret(value) {
    if (typeof value === 'string' && value.length > 0 && value.length >= 4) {
      this.secrets.add(value);
      // A registered connection URL also registers its embedded password so
      // messages containing only the password are still redacted.
      const password = urlPassword(value);
      if (password) this.secrets.add(password);
    }
  }

  redact(text) {
    let out = String(text);
    for (const secret of this.secrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }
}

export function createLogger(options = {}) {
  const {
    stream = process.stderr,
    isGitHubActions = process.env.GITHUB_ACTIONS === 'true',
    secrets = [],
  } = options;

  const redactor = new Redactor(secrets);

  function write(line) {
    stream.write(`${line}\n`);
  }

  function annotation(level, message) {
    write(`::${level}::${escapeAnnotation(redactor.redact(message))}`);
  }

  return {
    isGitHubActions,
    addSecret(value) {
      redactor.addSecret(value);
      return this;
    },
    redact(text) {
      return redactor.redact(text);
    },
    status(message) {
      write(redactor.redact(message));
    },
    warn(message) {
      const text = redactor.redact(message);
      if (isGitHubActions) annotation('warning', text);
      else write(text);
    },
    error(message) {
      const text = redactor.redact(message);
      if (isGitHubActions) annotation('error', text);
      else write(text);
    },
  };
}
