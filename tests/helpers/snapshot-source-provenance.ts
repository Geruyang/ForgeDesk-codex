import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type RepositoryGit = (root: string, args: string[]) => Promise<string>;
const repositoryGit: RepositoryGit = async (root, args) =>
  (await execute('git', args, { cwd: root, windowsHide: true, shell: false })).stdout;

export async function snapshotSourceProvenance(root: string, secondUser: boolean, git: RepositoryGit = repositoryGit) {
  if (secondUser) {
    return { sourceCommit: null, sourceDirty: null,
      sourceMetadataObservation: { status: 'not-observed', reason: 'Second-user acceptance does not query the shared repository Git: its ownership belongs to another Windows SID. Installed resource hashes identify the tested package; no current repository HEAD or dirty state is claimed.' } };
  }
  return { sourceCommit: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    sourceDirty: !!(await git(root, ['status', '--porcelain'])).trim(),
    sourceMetadataObservation: { status: 'observed', reason: 'Current repository HEAD and worktree status queried under the primary user.' } };
}
