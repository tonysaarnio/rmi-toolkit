import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TARGET_ORG = process.env.SF_TARGET_ORG || 'iewc-mfg-rca';

// A dropped connection to Salesforce presents as one of these, and is the one
// class of failure worth repeating: nothing about the request was wrong. Every
// other failure (compile error, Apex exception, pricing rejection) is real and
// must surface on the first attempt, so this list stays deliberately narrow.
const TRANSIENT_TRANSPORT_SIGNS = [
  'fetch failed',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'client network socket disconnected',
  'network timeout',
  'server response 502',
  'server response 503',
  'server response 504',
];

const TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_BACKOFF_MS = [2000, 5000];

/**
 * True when `text` carries the signature of a transport-level failure rather
 * than a rejection by the org.
 */
export function isTransientTransportError(text) {
  if (!text) return false;
  const haystack = String(text).toLowerCase();
  return TRANSIENT_TRANSPORT_SIGNS.some(sign => haystack.includes(sign));
}

function backoffFor(attempt) {
  return TRANSPORT_BACKOFF_MS[attempt] ?? TRANSPORT_BACKOFF_MS[TRANSPORT_BACKOFF_MS.length - 1];
}

// Both callers below are synchronous, so the wait has to be too.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a SOQL query against the target org.
 * Returns an array of record objects.
 *
 * Retries transport failures unconditionally — a read carries no risk of
 * repeating a side effect.
 */
export function query(soql) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = execSync(
        `sf data query --target-org "${TARGET_ORG}" --query "${soql.replace(/"/g, '\\"')}" --result-format json`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const parsed = JSON.parse(result);
      return parsed.result?.records ?? [];
    } catch (err) {
      const detail = `${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      if (attempt >= TRANSPORT_ATTEMPTS - 1 || !isTransientTransportError(detail)) throw err;
      sleepSync(backoffFor(attempt));
    }
  }
}

/**
 * Execute an anonymous Apex string against the target org.
 * Returns the raw output string.
 * Throws if the execution reports a compile or runtime error.
 *
 * `retries` opts this call into repeating transport failures, and defaults to
 * off because losing the response does not mean the Apex did not run — a slow
 * PST that times out client-side has very likely already committed its Quote.
 * Only pass it for Apex that can run twice without creating a second record.
 */
export function runApex(apexCode, { retries = 0 } = {}) {
  const tmpFile = join(tmpdir(), `rmi_apex_${Date.now()}.apex`);
  try {
    writeFileSync(tmpFile, apexCode, 'utf8');
    for (let attempt = 0; ; attempt++) {
      const result = spawnSync(
        'sf',
        ['apex', 'run', '--target-org', TARGET_ORG, '--file', tmpFile],
        { encoding: 'utf8' }
      );
      const output = (result.stdout ?? '') + (result.stderr ?? '')
        + (result.error ? `\n${result.error.message}` : '');
      if (result.status !== 0) {
        if (attempt < retries && isTransientTransportError(output)) {
          sleepSync(backoffFor(attempt));
          continue;
        }
        throw new Error(`Apex execution failed:\n${output}`);
      }
      if (output.includes('COMPILE ERROR') || output.includes('EXCEPTION_THROWN') && /Error \(execute/.test(output)) {
        throw new Error(`Apex error:\n${output}`);
      }
      return output;
    }
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Extract a debug log value from Apex output.
 * Looks for lines matching: DEBUG|<key>|<value>
 */
export function extractDebugValue(output, key) {
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes(`DEBUG|${key}|`)) {
      return line.split(`DEBUG|${key}|`)[1]?.trim();
    }
  }
  return null;
}

/**
 * Extract all debug log lines from Apex output.
 */
export function extractDebugLines(output) {
  // Decode HTML entities (sf CLI encodes | as &#124; in debug output)
  const decoded = output.replace(/&#124;/g, '|');
  return decoded
    .split('\n')
    .filter(l => l.includes('USER_DEBUG'))
    .map(l => {
      const match = l.match(/USER_DEBUG\s*\|\s*\[\d+\]\s*\|DEBUG\|(.+)/);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean);
}
