// net.Socket write() backpressure, as in Node 24: write answers false when
// the bytes it leaves unsent reach the 65536-byte high-water mark, which a
// write made before the connection does, writableNeedDrain stays true
// until 'drain', and 'drain' fires once the buffered bytes are sent. An
// echo client that waits for 'drain' when write answers false moves every
// byte.
import { connect, createServer, Socket } from "node:net";

const CHUNK = 65536;
const TOTAL = 64 * CHUNK;
const chunk = Buffer.alloc(CHUNK, 120);

const server = createServer((socket: Socket) => {
  socket.pipe(socket);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const client = connect(port, "127.0.0.1");
  console.log("small write before connect", client.write("hi"), client.writableLength);
  console.log("large write before connect", client.write(Buffer.alloc(70000, 121)), client.writableLength);
  console.log("need drain", client.writableNeedDrain);
  let sent = 70002;
  let received = 0;
  const pump = (): void => {
    while (sent < TOTAL) {
      sent += CHUNK;
      if (!client.write(chunk)) {
        client.once("drain", pump);
        return;
      }
    }
    client.end();
  };
  client.once("drain", () => {
    console.log("drain fired, need drain", client.writableNeedDrain, "pending", client.writableLength);
    pump();
  });
  client.on("data", (data: Buffer) => {
    received += data.length;
  });
  client.on("end", () => {
    console.log("received", received, "of", sent);
    server.close();
  });
});
