// Vercel Node.js server entrypoint.
// Vercel manages the HTTP/WebSocket listener; the application itself remains
// in backend/server.js for local development and the Android WebView client.
// @ts-nocheck
const { server } = require('./backend/server.js');

export default server;
