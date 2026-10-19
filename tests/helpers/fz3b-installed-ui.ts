import type { Page } from 'playwright';
import assert from 'node:assert/strict';
import type { Project } from '../../packages/shared/contracts';
import { samePath } from './embedded-installed';

export const FZ3B_UI = Object.freeze({
  taskTabs: '任务面板', taskTab: '实机流程', platformTabs: '设备平台', platformTab: 'FZ3B · Zynq',
  region: 'FZ3B 模型实机任务', instruction: 'FZ3B 模型任务指令', model: 'FZ3B 实机任务模型', start: '启动 FZ3B 模型任务',
  project: '.project-button', session: '.session-button', platformRole: 'tab' as const,
});

export function fz3bInstalledUi(page: Page) {
  const region = page.getByRole('region', { name: FZ3B_UI.region, exact: true });
  return {
    project: (project: Pick<Project, 'root'>, expectedRoot: string) => {
      assert.ok(samePath(project.root, expectedRoot), 'The observed project must still match the reviewed plan');
      return page.locator(FZ3B_UI.project).and(page.getByTitle(project.root, { exact: true }));
    },
    session: (title: string) => page.locator(FZ3B_UI.session).filter({ has: page.getByText(title, { exact: true }) }),
    taskTab: page.getByRole('tablist', { name: FZ3B_UI.taskTabs, exact: true }).getByRole('tab', { name: FZ3B_UI.taskTab, exact: true }),
    platformTab: page.getByRole('tablist', { name: FZ3B_UI.platformTabs, exact: true }).getByRole(FZ3B_UI.platformRole, { name: FZ3B_UI.platformTab, exact: true }),
    region, instruction: region.getByLabel(FZ3B_UI.instruction, { exact: true }), model: region.getByLabel(FZ3B_UI.model, { exact: true }),
    start: region.getByRole('button', { name: FZ3B_UI.start, exact: true }),
  };
}
