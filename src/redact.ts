/**
 * Secret redaction for Evidence excerpts (PLAN.md 2.3 rule, used from 2.1 on).
 * Raw secret values must never appear in Evidence, reports, lockfiles, or PR
 * comments. For URL-shaped values we keep host:port (needed for instance
 * identity) and strip credentials; for secret-named vars we drop the value.
 */

const SECRET_NAME = /(pass|pwd|secret|token|key|credential|auth|dsn)/i;

// scheme://[user[:pass]@]host[:port][/...]
const URL_WITH_CREDS = /^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+)@(.+)$/i;

export function redactValue(name: string, value: string): string {
  const trimmed = value.trim();

  const url = trimmed.match(URL_WITH_CREDS);
  if (url) return `${url[1]}<redacted>@${url[3]}`;

  if (SECRET_NAME.test(name)) return '<redacted>';

  return trimmed;
}

/** Render a `NAME=redacted-value` evidence excerpt. */
export function redactedAssignment(name: string, value: string): string {
  return `${name}=${redactValue(name, value)}`;
}

// Same shape as URL_WITH_CREDS but unanchored: catches credentials in URLs
// embedded anywhere in a source line (string literals at call sites).
const URL_CREDS_ANYWHERE = /([a-z][a-z0-9+.-]*:\/\/)([^@/\s"'`]+)@/gi;

/** Redact credentials inside URLs embedded anywhere in a source-code line. */
export function redactLine(line: string): string {
  return line.replace(URL_CREDS_ANYWHERE, '$1<redacted>@');
}
