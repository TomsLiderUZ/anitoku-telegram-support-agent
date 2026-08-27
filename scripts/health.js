'use strict';
/** Quick CLI health probe — usable as a Docker HEALTHCHECK or cron alert. */
const config = require('../src/config');

const url = `http://${config.admin.host === '0.0.0.0' ? '127.0.0.1' : config.admin.host}:${config.admin.port}/health`;

fetch(url)
  .then(async (res) => {
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error('health check failed:', err.message);
    process.exit(1);
  });
