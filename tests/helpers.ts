import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Workspace {
  base: string;
  dataDir: string;
  root: string;
  cleanup: () => void;
}

/** Isolated data dir + document root for each test. */
export function createWorkspace(): Workspace {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zoveli-intel-'));
  const dataDir = path.join(base, 'data');
  const root = path.join(base, 'root');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  return {
    base,
    dataDir,
    root,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export function writeFile(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export function fixedClock(iso = '2026-01-02T03:04:05.000Z'): () => Date {
  return () => new Date(iso);
}
