// Single-deployment Vercel API entrypoint for PhotoCall.
// Keeping the API under the same Vercel project removes the common
// "Backend offline" problem caused by a separately deployed/misconfigured URL.
module.exports = require('../backend/server.js');
