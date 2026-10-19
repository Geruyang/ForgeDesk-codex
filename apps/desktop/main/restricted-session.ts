import type { Session } from '../../../packages/shared/contracts';

type RunReference = { sessionId: string; taskId: string; threadId?: string };
export function restrictedSessionProfile(session: Session, stm32: readonly RunReference[], fz3b: readonly RunReference[]): 'stm32' | 'fz3b' | undefined {
  const explicit: unknown = session.engineProfile;
  if (explicit !== undefined && explicit !== 'stm32' && explicit !== 'fz3b') throw new Error('RESTRICTED_SESSION_PROFILE_INVALID');
  const matches = (run: RunReference) => run.sessionId === session.id && run.taskId === session.taskId ||
    !!session.threadId && !!run.threadId && run.threadId === session.threadId;
  const hasStm32 = stm32.some(matches), hasFz3b = fz3b.some(matches);
  if (hasStm32 && hasFz3b || explicit === 'stm32' && hasFz3b || explicit === 'fz3b' && hasStm32) throw new Error('RESTRICTED_SESSION_PROFILE_CONFLICT');
  return explicit ?? (hasStm32 ? 'stm32' : hasFz3b ? 'fz3b' : undefined);
}
