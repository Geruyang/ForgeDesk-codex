import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceSandboxArgs } from "./workspace-policy";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
const processHost = process.argv[3];
if (!executable || !processHost || !isAbsolute(executable) || !isAbsolute(processHost)) {
  throw new Error("Pass absolute official Codex and process-host executable paths");
}
const base = join(project, ".runtime", "sandbox-probe");
await mkdir(base, { recursive: true });
const run = await mkdtemp(join(base, "run-"));
const home = join(run, "engine");
const workspace = join(run, "workspace");
const protectedRoot = join(run, "protected-sibling");
await mkdir(home); await mkdir(workspace); await mkdir(protectedRoot);
const protectedFile = join(protectedRoot, "protected.txt");
await writeFile(protectedFile, "ORIGINAL_PROTECTED_CONTENT\n", { encoding: "utf8", flag: "wx" });

const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!/(?:CODEX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API.?KEY|ACCESS.?KEY|CREDENTIAL)/i.test(key)) env[key] = value;
}
env.CODEX_HOME = home;

type ProbeResult = { name: string; args: string[]; timeoutMs: number; timedOut: boolean; code: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; durationMs: number };
async function probe(name: string, args: string[]): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(processHost, ["--", executable, ...args], {
      cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    let stdout = ""; let stderr = ""; let timedOut = false; let truncated = false;
    const capture = (previous: string, chunk: Buffer) => {
      const text = previous + chunk.toString("utf8");
      if (Buffer.byteLength(text) > 65536) { truncated = true; return text.slice(0, 32768); }
      return text;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result: ProbeResult = { name, args, timeoutMs: 30000, timedOut, code, signal, stdout, stderr, truncated, durationMs: Date.now() - started };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      resolveResult(result);
    });
  });
}

const startedAt = new Date().toISOString();
const mxc = await probe("mxc-echo", [...workspaceSandboxArgs("mxc"), "cmd.exe", "/d", "/c", "echo", "MXC_OK"]);
const writeCode = 'const fs=require("node:fs"); try { fs.writeFileSync(process.argv[1],process.argv[2]); console.log("WRITE_ALLOWED"); } catch(error) { console.error("WRITE_DENIED "+error.code+" "+error.message); process.exitCode=13; }';
const sandboxArgs = [
  ...workspaceSandboxArgs(), process.execPath, "-e", writeCode,
];
const allowedFile = join(workspace, "allowed.txt");
const workspaceWrite = await probe("unelevated-workspace-write", [...sandboxArgs, allowedFile, "WORKSPACE_WRITE_CONTENT\n"]);
const protectedWrite = await probe("unelevated-protected-sibling-write", [...sandboxArgs, protectedFile, "UNEXPECTED_PROTECTED_WRITE\n"]);
const allowedContent = await readFile(allowedFile, "utf8").catch(() => null);
const protectedContent = await readFile(protectedFile, "utf8");
const result = {
  schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), executable, processHost, home, workspace, protectedFile,
  policy: { windowsSandbox: "unelevated", sandboxMode: "workspace-write", networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  probes: [mxc, workspaceWrite, protectedWrite],
  checks: {
    mxcEcho: mxc.code === 0 && !mxc.timedOut && mxc.stdout.includes("MXC_OK"),
    workspaceWritable: !workspaceWrite.timedOut && workspaceWrite.code === 0 && allowedContent === "WORKSPACE_WRITE_CONTENT\n",
    protectedSiblingDenied: !protectedWrite.timedOut && protectedWrite.code === 13 && /^WRITE_DENIED (?:EPERM|EACCES) /m.test(protectedWrite.stderr) && protectedContent === "ORIGINAL_PROTECTED_CONTENT\n",
  },
  contents: { allowedContent, protectedContent },
  limitations: "No elevation, external network or device probe. A single sibling-path denial is not a full filesystem or network boundary proof. Current engine route unchanged.",
};
const evidence = join(run, "result.json");
await writeFile(evidence, JSON.stringify(result, null, 2), "utf8");
process.stdout.write(`${JSON.stringify({ evidence, checks: result.checks, contents: result.contents })}\n`);
