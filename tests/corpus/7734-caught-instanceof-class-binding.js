// A catch binding tested against a class held by a binding (var/const class expression),
// as hono's SmartRouter tests UnsupportedPathError.
var UnsupportedPathError = class extends Error {};
class Strict {
  add(p) { if (p.includes("*")) throw new UnsupportedPathError(); return p; }
}
class Loose { add(p) { return "loose " + p; } }
function pick(p) {
  const routers = [new Strict(), new Loose()];
  for (const r of routers) {
    try {
      return r.add(p);
    } catch (e) {
      if (e instanceof UnsupportedPathError) continue;
      throw e;
    }
  }
}
console.log(pick("/a"), pick("/b/*"));
try { throw new Error("x"); } catch (e) { console.log(e instanceof UnsupportedPathError, e instanceof Error); }
const u = new UnsupportedPathError("m");
console.log(u instanceof UnsupportedPathError, u.message, u.name, u instanceof Error);
