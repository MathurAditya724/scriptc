// JavaScript callers of the Date field constructor and the date-string
// parser: arguments pass through ToNumber in order (valueOf runs, strings
// and booleans convert, a throwing conversion stops the rest), arguments
// past the seventh are evaluated but never converted, and RFC 1123 dates
// parse the way HTTP caching middleware reads them.
process.env.TZ = "Europe/Berlin";
const log = [];
const arg = (name, value) => ({ valueOf() { log.push(name); return value; } });
const d = new Date(arg("y", 2024), arg("m", 1), arg("d", 29), arg("h", 13), arg("mi", 5), arg("s", 6), arg("ms", 7), arg("extra", 8));
console.log(d.getTime(), d.toISOString(), log.join(","));
console.log(new Date("2024", "0", "15").getTime(), new Date(2024, true, null).getTime(), new Date(2024, undefined).getTime());
console.log(new Date(2024, 0, "x").getTime(), new Date(99, 0).getFullYear(), new Date(2024, 0, 1, 2, 3).getHours());
try {
  new Date(2024, arg("m", 0), { valueOf() { throw new Error("conversion stopped"); } }, arg("h", 1));
} catch (e) {
  console.log(e.message, log.slice(-1).join(","));
}
function isFresh(reqHeaders, resHeaders) {
  const modifiedSince = reqHeaders["if-modified-since"];
  const lastModified = resHeaders["last-modified"];
  if (!modifiedSince || !lastModified) return false;
  const lm = Date.parse(lastModified);
  const ms = Date.parse(modifiedSince);
  return !(isNaN(lm) || isNaN(ms) || lm > ms);
}
console.log(isFresh({ "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" }, { "last-modified": "Sun, 31 Dec 2023 00:00:00 GMT" }));
console.log(isFresh({ "if-modified-since": "Sun, 31 Dec 2023 00:00:00 GMT" }, { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" }));
console.log(isFresh({ "if-modified-since": "not a date" }, { "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" }));
const stamps = ["Tue, 15 Nov 1994 08:12:31 GMT", "Tuesday, 15-Nov-94 08:12:31 GMT", "Tue Nov 15 08:12:31 1994", "2024-03-31 02:30"];
for (const s of stamps) console.log(s, Date.parse(s), new Date(s).getTime());
