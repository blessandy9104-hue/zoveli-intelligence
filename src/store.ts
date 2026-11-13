import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StoreCorruptionError } from './errors.js';

/** Default local state directory. Never inside a repo checkout. */
export function resolveDataDir(explicit?: string): string {
  const fromEnv = process.env.ZOVELI_INTEL_DATA_DIR?.trim();
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.zoveli', 'intelligence');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read a JSON store. A missing file returns `fallback()`; malformed JSON or an
 * unexpected shape throws `StoreCorruptionError` so callers never silently
 * overwrite real user data with a fresh store.
 */
export function readJsonStore<T>(file: string, fallback: () => T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw new StoreCorruptionError(`cannot read ${file}: ${errorMessage(error)}`, { file });
  }
  if (!raw.trim()) return fallback();
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new StoreCorruptionError(`invalid JSON in ${file}: ${errorMessage(error)}`, { file });
  }
}

/** Atomic, owner-only write: temp file + rename on the same directory. */
export function writeJsonStore(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort
    }
    throw new StoreCorruptionError(`cannot write ${file}: ${errorMessage(error)}`, { file });
  }
}

export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
