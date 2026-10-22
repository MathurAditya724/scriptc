// Functions whose signatures cannot compile: the report still lists what
// their bodies would report. A use of the blocked parameter names the
// declaration; the body's own unsupported statement reports itself, with
// the reached diagnostics for a function the entry calls and as unreached
// for one nothing calls.
function measure(target: WeakRef<object>, label: string): number {
  const extra = new WeakRef({ label });
  console.log(target);
  return label.length + (extra === undefined ? 0 : 1);
}
function unused(target: WeakRef<object>): number {
  const extra = new WeakRef({ target });
  return extra === undefined ? 0 : 1;
}
console.log(measure(new WeakRef({}), "abc"));
