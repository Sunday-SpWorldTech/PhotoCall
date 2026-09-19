// Vercel entrypoint for the PhotoCall Express + Socket.IO backend.
// The actual application remains in backend/server.js so local development
// can continue to use: cd backend && npm run dev
const { server } = require('./backend/server');

module.exports = server;
