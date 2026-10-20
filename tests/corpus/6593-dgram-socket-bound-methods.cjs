// A dgram socket's methods read as values and bound to it (the transport
// wrapper shape): listeners registered, removed and emitted through the
// bound functions, the socket closed through its bound close, and an
// 'error' emitted after close still reaching the listener left on it.
'use strict';
const dgram = require('dgram');

function wrap(socket) {
  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    once: socket.once.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: function (buf, callback) {
      socket.send(buf, 0, buf.length, this.port, '127.0.0.1', callback);
    },
    close: socket.close.bind(socket),
    unref: socket.unref.bind(socket),
    port: 0,
  };
}

const server = dgram.createSocket('udp4');
let t;

function finish() {
  t.on('close', () => {
    console.log('closed');
    console.log('emit after close', t.emit('error', new Error('late')));
    t.removeListener('error', second);
    try {
      t.emit('error', new Error('unheard'));
    } catch (e) {
      console.log('threw', e.message);
    }
    server.close();
  });
  t.close();
}

server.on('message', (msg, rinfo) => {
  console.log('server got', msg.toString(), rinfo.family, rinfo.size);
  finish();
});

const first = (err) => console.log('first', err.message);
const second = (err) => console.log('second', err.message);

server.bind(0, '127.0.0.1', () => {
  t = wrap(dgram.createSocket('udp4'));
  t.port = server.address().port;
  t.unref();
  t.on('error', first);
  t.on('error', second);
  t.once('error', (err) => console.log('once', err.message));
  console.log('emit', t.emit('error', new Error('boom')));
  t.removeListener('error', first);
  console.log('emit', t.emit('error', new Error('again')));
  console.log('emit custom', t.emit('nobody'));
  t.send(Buffer.from('ping'), (err, bytes) => console.log('sent', err, bytes));
});
