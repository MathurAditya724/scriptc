// A path with a null byte in JavaScript: the sync forms throw, the callback
// forms throw before the callback is scheduled, and the promise forms
// reject, each with Node's ERR_INVALID_ARG_VALUE TypeError.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-nul-js-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "data");
const bad = path.join(dir, "na\0me");

function show(label, error) {
  console.log(label, error.name, error.code, error.message.replace(dir, "<dir>"));
}
function never() {
  console.log("callback ran");
}

const sync = [
  ["readFileSync", () => { fs.readFileSync(bad, "utf8"); }],
  ["writeFileSync", () => { fs.writeFileSync(bad, "x"); }],
  ["statSync", () => { fs.statSync(bad); }],
  ["lstatSync", () => { fs.lstatSync(bad); }],
  ["mkdirSync", () => { fs.mkdirSync(bad); }],
  ["readdirSync", () => { fs.readdirSync(bad); }],
  ["renameSync", () => { fs.renameSync(file, bad); }],
  ["copyFileSync", () => { fs.copyFileSync(file, bad); }],
  ["realpathSync", () => { fs.realpathSync(bad); }],
  ["unlinkSync", () => { fs.unlinkSync(bad); }],
  ["openSync", () => { fs.openSync(bad, "r"); }],
  ["createReadStream", () => { fs.createReadStream(bad); }],
  ["createWriteStream", () => { fs.createWriteStream(bad); }],
];
for (const [label, run] of sync) {
  try {
    run();
    console.log(label, "no throw");
  } catch (error) {
    show(label, error);
  }
}
console.log("existsSync", fs.existsSync(bad), fs.existsSync(file + "\0x"), fs.existsSync(file));

const callbacks = [
  ["readFile", () => { fs.readFile(bad, "utf8", never); }],
  ["writeFile", () => { fs.writeFile(bad, "x", never); }],
  ["stat", () => { fs.stat(bad, never); }],
  ["lstat", () => { fs.lstat(bad, never); }],
  ["mkdir", () => { fs.mkdir(bad, never); }],
  ["readdir", () => { fs.readdir(bad, never); }],
  ["unlink", () => { fs.unlink(bad, never); }],
  ["rename", () => { fs.rename(file, bad, never); }],
  ["copyFile", () => { fs.copyFile(bad, file, never); }],
  ["access", () => { fs.access(bad, never); }],
  ["open", () => { fs.open(bad, "r", never); }],
  ["realpath", () => { fs.realpath(bad, never); }],
  ["mkdtemp", () => { fs.mkdtemp(bad, never); }],
];
for (const [label, run] of callbacks) {
  try {
    run();
    console.log(label, "no throw");
  } catch (error) {
    show(label, error);
  }
}

async function promises() {
  try {
    await fs.promises.readFile(bad, "utf8");
    console.log("promises.readFile", "resolved");
  } catch (error) {
    show("promises.readFile", error);
  }
  try {
    await fs.promises.stat(bad);
    console.log("promises.stat", "resolved");
  } catch (error) {
    show("promises.stat", error);
  }
  try {
    await fs.promises.mkdir(bad);
    console.log("promises.mkdir", "resolved");
  } catch (error) {
    show("promises.mkdir", error);
  }
  try {
    await fs.promises.rename(bad, file);
    console.log("promises.rename", "resolved");
  } catch (error) {
    show("promises.rename", error);
  }
  try {
    await fs.promises.open(bad, "r");
    console.log("promises.open", "resolved");
  } catch (error) {
    show("promises.open", error);
  }
}

promises().then(() => fs.rmSync(dir, { recursive: true, force: true }));
