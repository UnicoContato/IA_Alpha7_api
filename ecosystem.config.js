const { getEnv, requireEnv } = require('./src/config/env');
const PORT = requireEnv('PORT');

module.exports = {
  apps: [{
    name: 'alpha7-ia',
      script: './app.js', // ou './index.js' ou './app.js' - ajuste conforme seu arquivo principal
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    env: {
      NODE_ENV: getEnv('NODE_ENV', 'production'),
      APP_NAME,
      PORT
    },
    error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
