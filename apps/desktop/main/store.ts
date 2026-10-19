import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Project, Session } from '../../../packages/shared/contracts';
const desktopStores = new WeakSet<object>();
export function assertDesktopStore(value: unknown): asserts value is DesktopStore {
  if (!value || typeof value !== 'object' || !desktopStores.has(value)) throw new Error('FZ3B_HOST_FINALIZATION_REAL_STORE_REQUIRED');
}
export class DesktopStore {
  projects: Project[] = [];
  sessions: Session[] = [];
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    const file = path.join(root, 'desktop.json');
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.sessions)) throw new Error('Unsupported desktop state schema');
      this.projects = data.projects;
      this.sessions = data.sessions;
      for (const s of this.sessions) if (['running', 'stopping'].includes(s.status)) { s.status = 'needs_attention'; s.historyIncomplete = true; s.engineUncertain = true; s.turnId = undefined; }
    }
    desktopStores.add(this);
  }
  save() {
    const file = path.join(this.root, 'desktop.json');
    writeFileSync(file + '.tmp', JSON.stringify({ schemaVersion: 1, projects: this.projects, sessions: this.sessions }));
    renameSync(file + '.tmp', file);
  }
  appendEvent(event: unknown) { appendFileSync(path.join(this.root, 'events.jsonl'), JSON.stringify({ schemaVersion: 1, ...event as object }) + '\n'); }
}
