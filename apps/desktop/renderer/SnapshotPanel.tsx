import { ChevronDown, FileCheck2, Layers, LoaderCircle, Play, ShieldCheck } from 'lucide-react';
import type { TaskView } from '../../../packages/shared/contracts';

export const SNAPSHOT_ACCEPTANCE_ID = 'snapshot-software';
const PROFILE_ID = 'forgedesk.node-software.v1';
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }
function formatted(value: unknown): string { return JSON.stringify(value, null, 2) ?? ''; }

export function snapshotBuildRetryKey(task: TaskView): string {
  const profile = record(task.snapshotProfile);
  return JSON.stringify([task.id, 'snapshot-build', profile.id ?? null, profile.revision ?? null, profile.profileDigest ?? null]);
}

export function SnapshotPanel({ task, enabling, building, busy, onEnable, onBuild, unavailable }: {
  task: TaskView; enabling: boolean; building: boolean; busy: boolean; onEnable: () => void; onBuild: () => void; unavailable: boolean;
}) {
  const profile = record(task.snapshotProfile);
  const isolation = record(profile.isolation);
  const hasProfile = typeof profile.id === 'string' && !!profile.id;
  const supported = profile.id === PROFILE_ID;
  const verifiedAt = typeof isolation.verifiedAt === 'string' ? isolation.verifiedAt : '';
  const verified = !!verifiedAt;
  const bEvidence = task.evidence.filter(item => item.evidenceLevel === 'B');
  return <section className="snapshot-section" aria-labelledby={`snapshot-heading-${task.id}`}>
    <div className="snapshot-heading"><h2 id={`snapshot-heading-${task.id}`}><Layers size={14} />任务快照</h2><span>{bEvidence.length ? `B 级证据 · ${bEvidence.length}` : '尚无 B 级证据'}</span></div>
    <p className="snapshot-template">{hasProfile && !supported ? '未支持的快照模板' : 'Node 算术示例 v1'}</p>
    <p className="snapshot-scope">适用：numbers.mjs · average 算术示例</p>
    {hasProfile ? <>
      <dl className="snapshot-profile"><dt>模板 ID</dt><dd>{text(profile.id)}</dd><dt>修订</dt><dd>{text(profile.revision) || '未记录'}</dd><dt>Node</dt><dd>{text(profile.nodeExecutable) || '未记录'}</dd></dl>
      <div className={`snapshot-probe ${verified ? 'verified' : ''}`}><ShieldCheck size={13} /><span>隔离探针：{verified ? '已验证' : '未记录'}</span>{verifiedAt && <time dateTime={verifiedAt} title={verifiedAt}>{verifiedAt}</time>}</div>
      {Object.keys(isolation).length > 0 && <details className="snapshot-probe-details"><summary>隔离探针记录</summary><pre>{formatted(isolation)}</pre></details>}
      <button className="secondary snapshot-command" onClick={onBuild} disabled={unavailable || !supported || !verified || enabling || building || busy} aria-label="快照构建">{building ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{building ? '快照构建中…' : '快照构建'}</button>
    </> : <button className="secondary snapshot-command" onClick={onEnable} disabled={unavailable || enabling || building || busy} aria-label="启用快照模板">{enabling ? <LoaderCircle className="spin" size={14} /> : <Layers size={14} />}{enabling ? '探测隔离环境…' : '启用快照模板'}</button>}
  </section>;
}

export function EvidenceRecord({ evidence }: { evidence: Record<string, unknown> }) {
  const level = text(evidence.evidenceLevel) || '未记录级别';
  const result = text(evidence.result || evidence.status || evidence.operationId) || '记录';
  const resultLabels: Record<string, string> = { passed: '通过', failed: '失败', stale: '证据过期', unknown: '待核验' };
  const snapshot = record(evidence.snapshot);
  const hasSnapshotMetadata = Object.keys(snapshot).length > 0 || typeof evidence.snapshotId === 'string';
  const snapshotFields = [
    { label: '快照 ID', value: evidence.snapshotId ?? snapshot.id },
    { label: '输入摘要', value: evidence.inputDigest },
    { label: '清单摘要', value: evidence.snapshotManifestDigest ?? snapshot.manifestDigest },
    { label: '模板修订', value: evidence.profileRevision ?? snapshot.profileRevision },
    { label: '快照输入', value: snapshot.inputRoot },
    { label: '产物目录', value: snapshot.outputRoot },
  ].filter(field => field.value !== undefined && field.value !== null);
  return <details className="record evidence-record">
    <summary><FileCheck2 size={14} /><span>{level} · {resultLabels[result] || result}</span><ChevronDown size={12} /></summary>
    {level === 'B' && <div className="snapshot-evidence"><strong>B 级任务快照证据</strong>{!hasSnapshotMetadata && <p>快照元数据未记录</p>}{snapshotFields.length > 0 && <dl>{snapshotFields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{text(field.value)}</dd></div>)}</dl>}</div>}
    <pre>{formatted(evidence)}</pre>
  </details>;
}
