import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAdapter, type CodexAdapterOptions } from '../../packages/engine-adapter/index';

export class OfflineControlsAdapter extends CodexAdapter {
  constructor(private readonly fixtureOptions: CodexAdapterOptions) { super(fixtureOptions); }

  protected override createProcess(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    const node = process.env.FORGEDESK_OFFLINE_NODE;
    const server = process.env.FORGEDESK_OFFLINE_SERVER;
    const journal = process.env.FORGEDESK_OFFLINE_JOURNAL;
    if (!node || !server || !journal || !this.fixtureOptions.processHost) throw new Error('Explicit offline fixture paths are required');
    return spawn(this.fixtureOptions.processHost, ['--', node, server], {
      cwd: this.fixtureOptions.home, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, FORGEDESK_OFFLINE_JOURNAL: journal },
    });
  }
}

export { OfflineControlsAdapter as CodexAdapter };
