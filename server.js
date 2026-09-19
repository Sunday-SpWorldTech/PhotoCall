const app = require('./backend/server.js');
const PORT = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(PORT, () => console.log(`PhotoCall backend listening on ${PORT}`));
module.exports = app;
