// Vercel Node.js entrypoint.
// The backend remains CommonJS so it can also run locally with: node server.js
// Vercel imports the exported HTTP server and handles the listener/runtime.
import backend from './backend/server.js';

const httpServer = (backend as any)?.server ?? backend;

export default httpServer;
