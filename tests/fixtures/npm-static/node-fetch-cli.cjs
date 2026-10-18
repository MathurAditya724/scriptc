// node-fetch@2 reads sloppy-mode `arguments` in transpiled defaults
// (`arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {}`).
const fetch = require("node-fetch");
console.log(typeof fetch);
