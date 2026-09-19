// PhotoCall production Node.js entrypoint for Vercel.
// The backend module exports the actual Node HTTP server, which is also
// accepted if Vercel is configured with the `backend` directory as Root.
// @ts-nocheck
const server = require('./backend/server.js');

// Vercel's Node server runtime accepts the server export.
export default server;
