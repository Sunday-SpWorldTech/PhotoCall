// Vercel entrypoint for the PhotoCall Express + Socket.IO server.
// backend/server.js is CommonJS, so import its default namespace and export
// the actual HTTP server that Vercel's Node runtime can serve.
import backend from './backend/server.js';

export default backend.server;
