const http = require("http");
const path = require("path");
const fs = require("fs/promises");

function fixtureServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
    srv.on("error", reject);
  });
}

module.exports = { fixtureServer };
