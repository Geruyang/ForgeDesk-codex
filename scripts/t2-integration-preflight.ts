import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { EmbeddedService } from '../packages/engineering-runner/embedded/index.js';
import { FixedStm32HardwareService } from '../packages/engineering-runner/device/real-stm32.js';

const root = process.cwd();
const run = `preflight-${Date.now()}`;
const output = path.join(root, 'output/hardware/t2-integration', run);
await mkdir(output, { recursive: true });
const processHost = path.join(root, 'vendor/process-host/process-host.exe');
const service = new EmbeddedService({
  dataDir: path.join(output, 'data'), processHost,
  templateRoot: path.join(root, 'engineering/templates/gesturescreen-v1'),
  hardware: new FixedStm32HardwareService({ processHost,
    pythonExecutable: path.join(root, 'vendor/hardware/python/python.exe'),
    workerScript: path.join(root, 'engineering/hardware-worker.py') }),
});
const task = 't2-preflight';
try {
  await service.configure(task, path.join(root, 'output/hardware/2026-10-15/GestureScreen'), { keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe' });
  const build = await service.build(task, 'build-once');
  await writeFile(path.join(output, 'build.json'), JSON.stringify(build, null, 2));
  console.log(JSON.stringify({ output, kind: 'build', operations: build.operations }));
  if (!build.operations.every(op => op.status === 'succeeded')) throw new Error('Build preflight failed; no hardware inspection attempted');
  const inspect = await service.inspect(task, 'inspect-once');
  await writeFile(path.join(output, 'inspect.json'), JSON.stringify(inspect, null, 2));
  console.log(JSON.stringify({ output, kind: 'inspect', operations: inspect.operations }));
  if (!inspect.operations.every(op => op.status === 'succeeded')) throw new Error('Read-only inspection failed');
} finally { await service.close(); }
