// Vercel entry point: importing server.js (rather than running it directly)
// makes it skip app.listen()/the reminder scheduler and just export the
// Express app, which Vercel's Node runtime calls as a request handler.
module.exports = require('../server.js');
