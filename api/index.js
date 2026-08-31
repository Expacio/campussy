'use strict';
// Vercel serverless entry point. Vercel's @vercel/node runtime calls the exported
// Express app as (req, res). All routes are rewritten here via vercel.json.
module.exports = require('../src/server');
