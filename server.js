import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const distOf = (pkg) => dirname(require.resolve(pkg));
const port = process.env.PORT || 3000;

// --- Wisp: the only part that actually touches the network ----------------
// Visitors can reach any host this tunnel allows. Left open, that includes
// anything only this server can see -- its own localhost, the host's private
// network, cloud metadata endpoints. Keep these off.
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.stream_limit_per_host = 64;
wisp.options.stream_limit_total = 512;

const app = express();

// The proxy runtime, served from the pinned packages in node_modules. These
// paths match what public/index.html expects.
app.use("/scram", express.static(scramjetPath));                                  // scramjet.js, scramjet.wasm
app.use("/scram", express.static(distOf("@mercuryworkshop/scramjet-utils")));      // scramjet-utils.js
app.use("/controller", express.static(distOf("@mercuryworkshop/scramjet-controller")));
app.get("/clients/libcurl-client.js", (_req, res) =>
  res.sendFile(require.resolve("@mercuryworkshop/libcurl-transport"))
);

// The service worker must come from the root so its scope covers /~/sj/, and
// must never be cached -- a stale worker is a stale proxy for every visitor.
app.use(
  express.static(join(here, "public"), {
    setHeaders(res, path) {
      if (path.endsWith("sw.js")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Service-Worker-Allowed", "/");
      }
    },
  })
);

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

const server = createServer(app);

// Wisp arrives as a WebSocket upgrade, which Express never sees.
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  else socket.destroy();
});

server.listen(port, () => console.log(`listening on :${port}`));
