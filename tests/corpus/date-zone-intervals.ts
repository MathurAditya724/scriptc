// Local-time fields of instants that walk across daylight-saving
// transitions: ascending and descending hourly sweeps longer than 19 days,
// minute steps around each transition, and instants in scattered order, in
// zones with 1-hour and 30-minute shifts and in both hemispheres. Every read
// answers the offset in effect at that instant, as in Node.

function fields(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()} ${d.getTimezoneOffset()}`;
}

function checksum(values: string[]): number {
  let h = 0;
  for (const v of values) for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return h;
}

const hour = 3600000;
const zones = ["America/New_York", "Europe/London", "Australia/Sydney", "Australia/Lord_Howe", "Asia/Kolkata"];
const starts = [Date.UTC(2024, 1, 20), Date.UTC(2024, 8, 15), Date.UTC(2023, 9, 1)];

for (const zone of zones) {
  process.env.TZ = zone;
  for (const start of starts) {
    const up: string[] = [];
    for (let t = start; t < start + 60 * 24 * hour; t += hour) up.push(fields(t));
    const down: string[] = [];
    for (let t = start + 60 * 24 * hour; t > start; t -= hour) down.push(fields(t));
    const offsets = new Set<number>();
    for (let t = start; t < start + 60 * 24 * hour; t += hour) offsets.add(new Date(t).getTimezoneOffset());
    console.log(zone, new Date(start).toISOString(), checksum(up), checksum(down), [...offsets].join("/"));
  }
  // Minute steps through each transition of 2024 and back.
  let previous = new Date(Date.UTC(2024, 0, 1)).getTimezoneOffset();
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2025, 0, 1); t += hour) {
    const offset = new Date(t).getTimezoneOffset();
    if (offset !== previous) {
      const near: string[] = [];
      for (let m = -90; m <= 90; m++) near.push(fields(t + m * 60000));
      for (let m = 90; m >= -90; m--) near.push(fields(t + m * 60000));
      console.log(zone, "transition", new Date(t).toISOString(), previous, offset, checksum(near));
      previous = offset;
    }
  }
  // Scattered instants: each lookup lands far from the last.
  const scattered: string[] = [];
  let x = 12345;
  for (let i = 0; i < 400; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    scattered.push(fields(Date.UTC(2020, 0, 1) + (x % 1800) * 24 * hour + (x % 24) * hour));
  }
  console.log(zone, "scattered", checksum(scattered));
}

// Tucumán changed its offset twice within 12 days in June 2004. Node's
// date cache takes an offset that matches 19 days apart as constant in
// between, so these reads answer by their order: ascending reads keep the
// May offset through June 12, descending reads see the June offset. Both
// are Node's answers.
const tucuman = [];
for (let day = 25; day <= 31; day++) tucuman.push(Date.UTC(2004, 4, day, 12));
for (let day = 1; day <= 20; day++) tucuman.push(Date.UTC(2004, 5, day, 12));
for (const order of ["ascending", "descending"]) {
  process.env.TZ = "UTC";
  process.env.TZ = "America/Argentina/Tucuman";
  const reads = new Map<number, string>();
  for (const t of order === "ascending" ? tucuman : tucuman.slice().reverse()) reads.set(t, fields(t));
  console.log(order, tucuman.map((t) => reads.get(t)).join(" | "));
}
