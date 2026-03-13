// PM2 process manager config for Hostinger VPS
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save          ← persist across reboots
//   pm2 startup       ← generate systemd startup command, then run that command

module.exports = {
  apps: [
    {
      name: "isc-transforms-mcp",
      script: "./dist/server.js",
      interpreter: "node",
      instances: 1,          // increase to "max" when you need horizontal scale
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        // ISC credentials for Phase 2 tools (shared server-side)
        // These are YOUR tenant creds — customers don't need to supply them.
        ISC_TENANT:            "YOUR-TENANT.identitynow.com",
        ISC_PAT_CLIENT_ID:     "YOUR_CLIENT_ID",
        ISC_PAT_CLIENT_SECRET: "YOUR_CLIENT_SECRET",
        ISC_MCP_MODE:          "readonly",   // change to 'write' to allow upsert
        ISC_MCP_DEBUG:         "false",
      },
      error_file: "./logs/err.log",
      out_file:   "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
