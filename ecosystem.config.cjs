// pm2 process definition for the events crawler + website.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// Listens on localhost only; nginx (/etc/nginx/conf.d/events.conf) puts a
// password in front of it on port 8080, because the admin API has no login.
module.exports = {
  apps: [
    {
      name: "events",
      cwd: "/home/ec2-user/events",
      script: "server.js",
      interpreter: "/home/ec2-user/.nvm/versions/node/v22.23.2/bin/node",
      // Node's default heap (~1.74 GB here) filled up and the process froze in GC before
      // max_memory_restart could fire (2026-11-03). With 2300 MB, RSS reaches 2500M first,
      // so PM2 restarts it cleanly (state saved on SIGTERM) instead.
      node_args: "--max-old-space-size=2300",
      env: {
        HOST: "127.0.0.1", PORT: "3200", NODE_ENV: "production",
        // headless Chromium (Playwright arm64 build) for calendars filled by script; re-point the link after an update
        EVENTS_CHROME: "/home/ec2-user/.local/bin/chrome-headless-shell",
      },
      instances: 1,
      exec_mode: "fork", // the crawler and its state live in-process; never cluster this
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "2500M", // raised from 1500M on 2026-11-01 (it hit the limit every ~5 min); the box has 3.8 GB; Berserk runs 3 AI processes (~200 MB each) besides
      kill_timeout: 10000, // time to save state on SIGTERM
      watch: false,
      error_file: "/home/ec2-user/.pm2/logs/events-error.log",
      out_file: "/home/ec2-user/.pm2/logs/events-out.log",
      time: true,
    },
  ],
};
