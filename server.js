import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;

// proxy-bootstrap downloads a compatible set of scramjet + controller +
// transport builds from npm on startup and serves them itself, so the versions
// can never drift out of sync. It owns these routes:
//   /sw.js  /bootstrap-init.js  /controller/*  /scram/*  /clients/*  /wisp/
// This needs registry.npmjs.org reachable at boot, and a writable cache dir.
const { routeRequest, routeUpgrade } = await bootstrap({
  transport: "libcurl",
  downloadedFilesDir: process.env.PROXY_CACHE_DIR || join(here, ".proxy-cache"),
});

const app = express();

// Bootstrap's routes win; anything it does not claim falls through to the UI.
app.use((req, res, next) => {
  if (!routeRequest(req, res)) next();
});

app.use(express.static(join(here, "public")));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

const server = createServer(app);

// Wisp is a WebSocket upgrade, so Express never sees it. Anything that is not
// a Wisp upgrade gets dropped rather than left hanging.
server.on("upgrade", (req, socket, head) => {
  if (routeUpgrade(req, socket, head)) return;
  socket.destroy();
});

server.listen(port, () => {
  console.log(`listening on :${port}`);
});
