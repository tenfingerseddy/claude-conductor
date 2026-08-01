// S5 throwaway: bind an HTTP server to one address only and report the bind result shape.
// Usage: node bind-test.js <address> <port>
const http = require("http");
const addr = process.argv[2];
const port = Number(process.argv[3] || 8787);

const server = http.createServer((_req, res) => res.end("conductor s5\n"));

server.on("error", (err) => {
  console.log(JSON.stringify({ ok: false, code: err.code, errno: err.errno, syscall: err.syscall, address: err.address, port: err.port, message: err.message }));
  process.exit(2);
});

server.listen(port, addr, () => {
  console.log(JSON.stringify({ ok: true, listening: server.address(), pid: process.pid }));
});
