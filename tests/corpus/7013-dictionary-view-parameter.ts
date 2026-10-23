// A record passed to a `{}` parameter and converted to a dictionary inside
// the function is the same object: the write through the dictionary
// reaches the caller's record.
const key = process.argv.length > 99 ? "never" : "added";
function stamp(value: {}): void {
  const table: Record<string, string> = value;
  table[key] = "y";
}
const record: { a: string } = { a: "x" };
stamp(record);
console.log(JSON.stringify(record), key in record);
