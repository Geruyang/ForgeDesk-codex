import path from 'node:path';
import type { CommandSpec } from '../types.js';
import { GESTURESCREEN_PROFILE as PROFILE } from './profile.js';

export function keilBuildCommand(executable: string, snapshot: string, logPath: string): CommandSpec {
  if ([executable, snapshot, logPath].some(value => !path.isAbsolute(value) || value.includes('\0'))) {
    throw new Error('Keil build paths must be absolute and contain no NUL');
  }
  return {
    executable,
    // UV4's own batch option suppresses its GUI beyond the inherited hidden startup state.
    args: ['-b', path.join(snapshot, PROFILE.uvprojx), '-j0', '-t', PROFILE.target, '-o', logPath],
    cwd: path.join(snapshot, 'MDK-ARM'),
    timeoutMs: 180000,
  };
}
