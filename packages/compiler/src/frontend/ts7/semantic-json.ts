/** Check the only JSON string form the native runtime cannot yet retain.
 * JSON.parse itself validates grammar. A valid surrogate pair is preserved;
 * a lone escape must not change a type literal or symbol name. */
export function checkSemanticJsonStrings(json: string, preservesSurrogates: boolean): void {
  // Most checker responses contain no Unicode escapes. Inspect only escape
  // sequences instead of mapping every native string index to UTF-16. Valid
  // JSON has no backslashes outside strings; JSON.parse checks the grammar.
  if (preservesSurrogates || !json.includes("\\u")) return;
  for (let index = json.indexOf("\\"); index >= 0; index = json.indexOf("\\", index + 1)) {
    if (json.charCodeAt(++index) !== 117) continue;
    const unit = jsonHexUnit(json, index + 1);
    index += 4;
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff && json.charCodeAt(index + 1) === 92 && json.charCodeAt(index + 2) === 117) {
      const next = jsonHexUnit(json, index + 3);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 6;
        continue;
      }
    }
    throw new Error("TypeScript semantic response: runtime cannot preserve lone UTF-16 surrogates");
  }
}

function jsonHexUnit(json: string, offset: number): number {
  if (offset + 4 > json.length) return -1;
  let value = 0;
  for (let index = offset; index < offset + 4; index++) {
    const code = json.charCodeAt(index);
    const digit =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 65 && code <= 70
          ? code - 55
          : code >= 97 && code <= 102
            ? code - 87
            : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

// Capability-based so the boundary automatically disappears once native
// strings and JSON parsing support lossless UTF-16. Probe once per process.
const preservesJsonSurrogates = (JSON.parse('"\\ud800"') as string).charCodeAt(0) === 0xd800;

export function parseSemanticJson<T>(json: string): T {
  checkSemanticJsonStrings(json, preservesJsonSurrogates);
  return JSON.parse(json) as T;
}
