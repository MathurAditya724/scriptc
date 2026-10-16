// With no 'checkContinue' or 'checkExpectation' listener, the server
// answers an HTTP/1.1 `Expect: 100-continue` with "100 Continue" before
// the 'request' handler runs, and answers any other expectation with 417
// without calling the handler. HTTP/1.0 requests ignore Expect.
import * as http from "node:http";
import * as net from "node:net";
const server = http.createServer((req, res) => res.end("body"));
const cases = ["100-continue", "100-Continue, foo", "foo", "x100-continue"];
server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  for (const e of cases) {
    const d = await new Promise<string>((r) => {
      let d = "";
      const s = net.connect({ port, host: "127.0.0.1" }, () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\nExpect: ${e}\r\n\r\n`));
      s.on("data", (c: Buffer) => (d += c.toString("latin1")));
      s.on("close", () => r(d));
    });
    console.log(e, JSON.stringify(d.replace(/Date: [^\r]*\r\n/, "")));
  }
  const http10 = await new Promise<string>((r) => {
    let d = "";
    const s = net.connect({ port, host: "127.0.0.1" }, () => s.write("GET / HTTP/1.0\r\nExpect: foo\r\n\r\n"));
    s.on("data", (c: Buffer) => (d += c.toString("latin1")));
    s.on("close", () => r(d));
  });
  console.log("1.0", JSON.stringify(http10.replace(/Date: [^\r]*\r\n/, "")));
  server.close();
});
