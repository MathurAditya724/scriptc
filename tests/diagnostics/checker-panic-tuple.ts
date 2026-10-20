// `''.match(/x/) || []` drives tsgo into the TupleType interface-conversion
// panic (upstream signature 01/13) whenever the union's members are
// serialized: the union stays unmappable, so the statement reports its own
// refusals — a failed compile, never a crashed CLI.
const a = ''.match(/x/) || [];
console.log(a.length);
