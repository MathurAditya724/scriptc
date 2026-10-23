// Writes to frozen records in sloppy-mode code leave them unchanged, where
// strict mode code throws (7404). The records are typed through JSDoc, so
// the writes are native record writes.

/** @typedef {{ count: number, label: string }} Counter */
/** @typedef {{ id: number, note?: string }} Note */

/** @param {Counter} c */
function bump(c) {
  c.count += 1;
  c.label = c.label + "!";
}

/** @param {Note} n */
function dropNote(n) {
  delete n.note;
}

/** @param {number} count @returns {Counter} */
function counter(count) {
  return { count: count, label: "c" + count };
}

const open = counter(1);
const frozen = Object.freeze(counter(2));
bump(open);
bump(frozen);
console.log(JSON.stringify(open), JSON.stringify(frozen), Object.isFrozen(frozen));

/** @type {Note} */
const note = { id: 1, note: "n" };
Object.freeze(note);
dropNote(note);
console.log(JSON.stringify(note));
