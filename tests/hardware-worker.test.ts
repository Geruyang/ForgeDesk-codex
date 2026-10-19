import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(".");
const python = join(repo, "vendor", "hardware", "python", "python.exe");
const testRoot = join(repo, "output", "hardware", "offline-worker-tests");

test("fixed worker rejects changed Flash after clean reset and records bounded real progress", async () => {
  if (!existsSync(python)) return;
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "case-"));
  try {
    const code = String.raw`
import importlib.util,json,pathlib,sys,types
from pyocd.core.target import Target
spec=importlib.util.spec_from_file_location('worker',r'${join(repo, "engineering", "hardware-worker.py").replaceAll("\\", "\\\\")}')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
directory=pathlib.Path(r'${directory.replaceAll("\\", "\\\\")}')
progress=w.ProgressWriter(directory,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','flash')
progress.update('preflight')
progress.update('preflash_compare',0,w.FLASH_SIZE,'bytes')
backup=bytes([255])*w.FLASH_SIZE
uid=bytes.fromhex('1b0037000451333136323832')
class FakeTarget:
 def __init__(self,mutate=False,ipsr=0):
  self.data=bytearray(backup);self.mutate=mutate;self.ipsr=ipsr;self.resets=[];self.runs=0
 def reset_and_halt(self,kind):
  self.resets.append(kind)
  if self.mutate:self.data[0x4000]=0
 def get_state(self):return Target.State.HALTED
 def reset(self):self.runs+=1
 def read_core_register(self,name):return self.ipsr
 def read32(self,address):return 0x10006419
 def read16(self,address):return 1024
 def read_memory_block8(self,address,count):
  if address==0x1fff7a10:return uid
  return self.data[address-w.FLASH_START:address-w.FLASH_START+count]
receipt={'target':{'chipId':w.CHIP_ID,'flashSizeKiB':1024,'uid96':w.UID_CANONICAL}}
clean=FakeTarget()
w.prepare_flash_target(clean,backup,progress,receipt)
assert clean.resets==[Target.ResetType.SYSRESETREQ]
assert receipt['precommitReset']['flashSha256']==w.sha256(backup)
saved=json.loads((directory/'progress.json').read_text())
assert saved['stage']=='preflash_compare' and saved['completed']==w.FLASH_SIZE
assert saved['total']==w.FLASH_SIZE and saved['unit']=='bytes'
assert saved['sequence']==progress.sequence
assert saved['operationId']=='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
assert saved['action']=='flash'
for bad in (FakeTarget(mutate=True),FakeTarget(ipsr=3)):
 try:w.prepare_flash_target(bad,backup,progress,receipt);assert False
 except ValueError:pass
assert progress.sequence>1
class FakeConnection:
 def subscribe(self,callback,events):self.callback=callback;self.events=events
connection=FakeConnection()
callback=w.subscribe_flash_progress(connection,progress)
connection.callback(types.SimpleNamespace(event=Target.Event.PRE_FLASH_ERASE))
callback(0.25)
erase=json.loads((directory/'progress.json').read_text())
assert erase['stage']=='erase_program' and erase['completed']==0.25
connection.callback(types.SimpleNamespace(event=Target.Event.PRE_FLASH_PROGRAM))
callback(0.5)
program=json.loads((directory/'progress.json').read_text())
assert program['completed']==0.5 and program['sequence']>erase['sequence']
assert program['message']=='Programming pages'
assert w.capture_flash_fault(clean)['state']=='HALTED'
class LockedTarget(FakeTarget):
 def get_state(self):return Target.State.LOCKUP
 def read_core_register(self,name):raise AssertionError('core register read on lockup')
locked=w.capture_flash_fault(LockedTarget())
assert locked['state']=='LOCKUP' and 'cfsr' in locked and 'pc' not in locked
def row(kind,address,payload=b''):
 body=bytes([len(payload),address>>8,address&255,kind])+payload
 return ':'+(body+bytes([-sum(body)&255])).hex().upper()+'\n'
vector=(0x20030000).to_bytes(4,'little')+(0x08000011).to_bytes(4,'little')+bytes(8)
artifact=(row(4,0,bytes([8,0]))+row(0,0,vector)+row(0,16,b'\x42\x43')+row(1,0)).encode()
hex_path=directory/'fixture.hex';hex_path.write_bytes(artifact)
backup_path=directory/'backup.bin';backup_path.write_bytes(backup)
target=FakeTarget()
class FakeSession:
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def __init__(self):self.target=target
 def subscribe(self,callback,events):self.callback=callback
class FakeMemoryLoader:
 def __init__(self,connection,progress,**kwargs):
  assert kwargs['chip_erase']=='sector' and kwargs['keep_unwritten']
  self.connection=connection;self.progress=progress;self.chunks=[]
 def add_data(self,address,payload):self.chunks.append((address,payload))
 def commit(self):
  self.connection.callback(types.SimpleNamespace(event=Target.Event.PRE_FLASH_ERASE))
  self.progress(0.5)
  self.connection.callback(types.SimpleNamespace(event=Target.Event.PRE_FLASH_PROGRAM))
  self.progress(0.5)
  for address,payload in self.chunks:
   start=address-w.FLASH_START;target.data[start:start+len(payload)]=payload
  self.progress(1)
fake_loader=types.ModuleType('pyocd.flash.loader');fake_loader.MemoryLoader=FakeMemoryLoader
sys.modules['pyocd.flash.loader']=fake_loader
w.find_probe=lambda:object()
w.session=lambda *args:FakeSession()
def fail_telemetry(path,value):
 raise OSError('telemetry disk unavailable')
w.atomic_progress_json=fail_telemetry
flash_progress=w.ProgressWriter(directory,'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb','flash')
flash_receipt={'operationId':'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb','stage':'preflight'}
w.flash({'artifact':{'hexPath':str(hex_path),'hexSha256':w.sha256(artifact)},
         'backup':{'path':str(backup_path),'sha256':w.sha256(backup)},
         'operationDir':str(directory)},flash_receipt,flash_progress)
assert flash_receipt['stage']=='reset_and_exited' and flash_receipt['readbackMismatchBytes']==0
assert target.resets==[Target.ResetType.SYSRESETREQ] and target.runs==1
assert json.loads((directory/'phase.json').read_text())['dangerous'] is True
print('offline reset and progress fixtures passed')`;
    const output = execFileSync(python, ["-I", "-B", "-c", code], {
      cwd: repo, encoding: "utf8", timeout: 30000,
    });
    assert.match(output, /offline reset and progress fixtures passed/);
  } finally {
    if (!directory.startsWith(testRoot + "\\") && !directory.startsWith(testRoot + "/")) {
      throw new Error("Unsafe test cleanup path");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("progress telemetry recovers from one Windows replace failure under concurrent readers", async () => {
  if (!existsSync(python)) return;
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "telemetry-"));
  try {
    const code = String.raw`
import importlib.util,json,pathlib,threading,time
spec=importlib.util.spec_from_file_location('worker',r'${join(repo, "engineering", "hardware-worker.py").replaceAll("\\", "\\\\")}')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
directory=pathlib.Path(r'${directory.replaceAll("\\", "\\\\")}')
writer=w.ProgressWriter(directory,'cccccccc-cccc-4ccc-cccc-cccccccccccc','flash')
original_replace=w.os.replace
fail_once=[True]
def replace_once(source,target):
 if fail_once[0] and pathlib.Path(target).name=='progress.json':
  fail_once[0]=False
  raise PermissionError('simulated Windows sharing violation')
 return original_replace(source,target)
w.os.replace=replace_once
writer.update('preflight')
assert writer.sequence==-1 and not (directory/'progress.json').exists()
assert not list(directory.glob('progress.json.*.tmp'))
writer.update('connecting')
assert writer.sequence==0
assert json.loads((directory/'progress.json').read_text())['stage']=='connecting'
stop=threading.Event();errors=[];reads=[0]
def reader():
 while not stop.is_set():
  try:
   with open(directory/'progress.json','r',encoding='utf-8') as stream:
    value=json.loads(stream.read())
    assert value['schemaVersion']==1 and value['operationId']==writer.operation_id
    reads[0]+=1
    time.sleep(0.001)
  except OSError:
   pass
  except Exception as error:
   errors.append(error);stop.set()
threads=[threading.Thread(target=reader) for _ in range(4)]
for thread in threads:thread.start()
for index in range(200):
 writer.update('readback',index,200,'bytes',force=True)
stop.set()
for thread in threads:thread.join(timeout=5)
assert not errors and reads[0]>0
writer.update('finalizing',force=True)
saved=json.loads((directory/'progress.json').read_text())
assert saved['stage']=='finalizing' and saved['sequence']==writer.sequence
assert not list(directory.glob('progress.json.*.tmp'))
print('telemetry recovered and concurrent reads stayed valid')`;
    const output = execFileSync(python, ["-I", "-B", "-c", code], {
      cwd: repo, encoding: "utf8", timeout: 30000,
    });
    assert.match(output, /telemetry recovered and concurrent reads stayed valid/);
  } finally {
    if (!directory.startsWith(testRoot + "\\") && !directory.startsWith(testRoot + "/")) {
      throw new Error("Unsafe test cleanup path");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
