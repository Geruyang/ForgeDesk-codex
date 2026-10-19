import path from 'node:path';
import { commandEnvironment } from '../environment.js';

export function fz3bSshEnvironment(hostEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv & { ProgramData: string } {
  const name = Object.keys(hostEnvironment).find(key => key.toLowerCase() === 'programdata');
  const directory = name ? hostEnvironment[name] : undefined;
  if (!directory || !path.isAbsolute(directory) || /[\r\n\0]/.test(directory)) throw new Error('FZ3B_WINDOWS_PROGRAMDATA_REQUIRED');
  // Windows OpenSSH needs this known host folder even with its config disabled.
  return { ...commandEnvironment(), ProgramData: path.resolve(directory) };
}
