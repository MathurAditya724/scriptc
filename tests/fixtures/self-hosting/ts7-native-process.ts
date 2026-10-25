import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeTs7Process } from "../../../packages/compiler/src/frontend/ts7/native-process.js";
import { createNativeTs7Api } from "../../../packages/compiler/src/frontend/ts7/native-api.js";
import { Ts7RpcClient } from "../../../packages/compiler/src/frontend/ts7/rpc-client.js";
import { Ts7Wire } from "../../../packages/compiler/src/frontend/ts7/rpc-wire.js";
import { runTs7Client } from "./ts7-client-cases.js";

function check(value: boolean, label: string): void {
  if (!value) throw new Error(label);
}

function checkApi(executable: string, directory: string): void {
  const path = join(directory, "native-api.ts").replace(/\\/g, "/");
  const config = join(directory, "native-api.tsconfig.json").replace(/\\/g, "/");
  let text = "export const answer = 42;\n";
  const api = createNativeTs7Api({
    executable, cwd: directory, collectTiming: true,
    fs: {
      readFile: (file) => file === path ? text : file === config ? JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] as string[] }, files: [path],
      }) : undefined,
      fileExists: (file) => file === path || file === config ? true : undefined,
      directoryExists: () => undefined,
      realpath: () => undefined,
      getAccessibleEntries: () => undefined,
    },
  });
  try {
    check(api.parseConfigFile(config).fileNames.includes(path), "native API config callback");
    const first = api.updateSnapshot({ openProjects: [config] });
    const project = first.getProject(config)!;
    check(project.program.getSourceFile(path)!.text === text, "native API source");
    check(project.program.getSemanticDiagnostics(path).length === 0, "native API valid program");
    text = 'export const answer: number = "bad";\n';
    const second = api.updateSnapshot({ fileChanges: { changed: [path] } });
    check(second.getProject(config)!.program.getSemanticDiagnostics(path).some((d) => d.code === 2322), "native API updated diagnostics");
    check(project.program.getSemanticDiagnostics(path).length === 0, "native API old snapshot");
    check(api.getTimingInfo().totals.sourceFilesFetched > 0, "native API timing");
    first.dispose();
    second.dispose();
  } finally {
    api.close();
    api.close();
  }
  let refused = false;
  try { api.updateSnapshot(); } catch { refused = true; }
  check(refused, "closed native API");
}

function checkTransport(executable: string): void {
  let failed = false;
  try { new NativeTs7Process(executable + ".missing", "echo"); }
  catch (error) { failed = error instanceof Error && error.message.startsWith("TypeScript server startup:"); }
  check(failed, "native startup error");
  failed = false;
  try { new NativeTs7Process(executable, "bad\0cwd"); } catch { failed = true; }
  check(failed, "embedded NUL refused");
  const child = new NativeTs7Process(executable, "echo");
  check(child.pid > 0, "native PID");
  try {
    const storage = new Uint8Array([90, 91, 0, 255, 128, 33, 92, 93]);
    const view = storage.subarray(1, 7);
    let sent = 0;
    while (sent < 4) sent += child.write(view, 1 + sent, 4 - sent);
    const output = new Uint8Array(8);
    for (let i = 0; i < output.length; i++) output[i] = 77;
    const destination = output.subarray(1, 7);
    let received = 0;
    while (received < 4) received += child.read(destination, 1 + received, 4 - received);
    check(output.join(",") === "77,77,0,255,128,33,77,77", "mutable FFI view and offsets");
    check(child.read(view, view.length, 0) === 0 && child.write(view, 0, 0) === 0, "zero transfers");
    for (const offset of [-1, 0.5, 8, Number.NaN]) {
      failed = false;
      try { child.read(view, offset, 1); } catch (error) { failed = error instanceof RangeError; }
      check(failed, "invalid native read offset");
      failed = false;
      try { child.write(view, offset, 1); } catch (error) { failed = error instanceof RangeError; }
      check(failed, "invalid native write offset");
    }
  } finally {
    child.close();
    child.close();
  }
  failed = false;
  try { child.read(new Uint8Array(0), 0, 0); } catch { failed = true; }
  check(failed, "closed transport refuses reads");
  const exited = new NativeTs7Process(executable, "exit");
  const byte = new Uint8Array(1);
  check(exited.read(byte, 0, 1) === 0, "native EOF");
  failed = false;
  try { exited.write(byte, 0, 1); } catch { failed = true; }
  check(failed, "native broken pipe");
  exited.close();
  console.log("native transport passed");
}

const executable = process.argv[2]!;
const directory = process.argv[3]!;
const report = process.argv[4]!;
const mode = process.argv[5] ?? "client";
if (mode === "transport") {
  checkTransport(executable);
} else if (mode === "exit" || mode === "normal-exit") {
  const child = new NativeTs7Process(executable, "stall");
  const byte = new Uint8Array(1);
  check(child.read(byte, 0, 1) === 1 && byte[0] === 33, "server started before parent exit");
  writeFileSync(report, String(child.pid));
  if (mode === "exit") process.exit(0);
} else {
  checkApi(executable, directory);
  const child = new NativeTs7Process(executable, directory, true);
  runTs7Client(new Ts7RpcClient(new Ts7Wire(child)), directory, report);
  child.close();
}
