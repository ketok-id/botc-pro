// Runs the BOTC WebSocket server without Electron, for dedicated/hosted play.
//   node src/main/server-standalone.js --port 7878
// By default the renderer in src/renderer/ is served over HTTP on the same
// port so browser clients can play at http(s)://<host>/. Pass --no-web to run
// WS-only (legacy headless behaviour).
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const port = parseInt(arg('--port', process.env.PORT || '7878'), 10);
const bind = arg('--bind', '0.0.0.0');

let webRoot = null;
if (!hasFlag('--no-web')) {
  // Default: serve the bundled renderer if it's present in the image.
  const candidate = arg('--web-root', path.join(__dirname, '..', 'renderer'));
  if (fs.existsSync(candidate)) webRoot = candidate;
}

startServer({ port, bind, webRoot }).then((srv) => {
  if (webRoot) {
    console.log(`[botc-pro] server listening http://${bind}:${srv.port}  (web + ws on same port)`);
  } else {
    console.log(`[botc-pro] server listening ws://${bind}:${srv.port}  (ws-only)`);
  }
  console.log(`[botc-pro] join code format: <host>:<port>/<roomCode>`);
}).catch((err) => {
  console.error('[botc-pro] failed to start:', err);
  process.exit(1);
});
