/**
 * PM2 process definition — recommended way to run the agent 24/7.
 *   pm2 start ecosystem.config.js && pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'anitoku-agent',
      script: 'src/index.js',
      instances: 1,              // single instance: one Telegram session, one SQLite writer
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '600M',
      watch: false,
      time: true,
      env: { NODE_ENV: 'production' },
      out_file: 'data/logs/pm2-out.log',
      error_file: 'data/logs/pm2-err.log',
      merge_logs: true,
      kill_timeout: 10000,
    },
  ],
};
