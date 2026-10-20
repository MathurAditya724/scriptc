const { EventEmitter } = require("node:events");

class Channel extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }
  send(message) {
    this.emit("message", message, this.name);
  }
}
const Plain = class {
  constructor() {
    this.kind = "plain";
  }
};
module.exports = { Channel, Plain };
