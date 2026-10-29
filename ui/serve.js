// Tiny static server for the ChainTrust UI. Serves ./ui plus the local
// deployment addresses at /deployment.json. Usage: npm run ui
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DEPLOYMENT = path.join(__dirname, "..", "deployments", "localhost.json");

http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];
    const file = url === "/deployment.json" ? DEPLOYMENT : path.join(__dirname, url === "/" ? "index.html" : path.normalize(url));
    if (!file.startsWith(__dirname) && file !== DEPLOYMENT) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found (run `npm run deploy:local` first for /deployment.json)");
        return;
      }
      const type = file.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
      res.writeHead(200, { "Content-Type": type }).end(data);
    });
  })
  .listen(PORT, () => console.log(`ChainTrust UI: http://localhost:${PORT}`));
