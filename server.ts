// Vercel entrypoint. Vercel's current Node runtime can host Express + Socket.IO WebSockets.
// See: https://vercel.com/changelog/websocket-support-is-now-in-public-beta
import { server } from './backend/server.js';
export default server;
