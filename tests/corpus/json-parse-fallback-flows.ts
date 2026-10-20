// Checked-cast fallback across declaration forms and control flow: an
// annotated declaration from an untyped value, `unknown as T`, a site in a
// loop whose iterations alternate between fitting and failing values,
// closures and callbacks over the failed value, and a value that fits a
// typed parameter once it reaches it.
interface Job {
  name: string;
  retries: number;
  steps: string[];
}

function retriesOf(n: number): string {
  return n === 1 ? "1 retry" : `${n} retries`;
}

function annotated(text: string): void {
  const job: Job = JSON.parse(text);
  console.log("annotated", job.name, job.retries, job.steps?.length);
}

function fromUnknown(value: unknown): void {
  const job = value as Job;
  console.log("unknown", job.name ?? "(unnamed)", typeof job.retries);
}

function loop(texts: string[]): void {
  for (const text of texts) {
    const job = JSON.parse(text) as Job;
    const label = job.name + ":" + job.retries;
    console.log("loop", label, typeof job.retries === "number" ? retriesOf(job.retries) : "n/a");
  }
}

async function later(text: string): Promise<void> {
  const job = JSON.parse(text) as Job;
  const steps = job.steps ?? [];
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  steps.forEach((step, i) => console.log("step", i, step));
  const upper = steps.map((s) => String(s).toUpperCase());
  console.log("upper", upper.join(" "));
  const describeJob = (): string => `${job.name} (${job.retries})`;
  console.log("closure", describeJob());
}

annotated('{"name":"a","retries":1,"steps":["x"]}');
annotated('{"name":"b","retries":"2"}');
fromUnknown(JSON.parse('{"name":"c","retries":3,"steps":[]}'));
fromUnknown(JSON.parse('{"retries":"3"}'));
loop([
  '{"name":"d","retries":1,"steps":[]}',
  '{"name":"e","retries":"x","steps":[]}',
  '{"name":"f","retries":2,"steps":[]}',
  '{"name":"g"}',
]);
later('{"name":"h","retries":0,"steps":["s1","s2"]}').then(() =>
  later('{"name":"i","retries":"0","steps":["s1",2]}'),
);
