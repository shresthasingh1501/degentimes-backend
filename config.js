// ================================================
// FILE: config.js
// ================================================
import dotenv from 'dotenv';

dotenv.config();

const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  openservApiKey: process.env.OPENSERV_API_KEY,
  openservConnectSid: process.env.OPENSERV_CONNECT_SID,
  openservAgentId: process.env.OPENSERV_AGENT_ID || '140',
  openservWorkspaceIdWatchlist: process.env.OPENSERV_WORKSPACE_ID_WATCHLIST || '3422',
  openservWorkspaceIdSector: process.env.OPENSERV_WORKSPACE_ID_SECTOR || '3420',
  openservWorkspaceIdNarrative: process.env.OPENSERV_WORKSPACE_ID_NARRATIVE || '3421',
  openservWorkspaceIdTelegram: process.env.OPENSERV_WORKSPACE_ID_TELEGRAM || '3416',
  openservAgentIdTelegram: process.env.OPENSERV_AGENT_ID_TELEGRAM || '267',
  jobIntervalMs: parseInt(process.env.JOB_INTERVAL_MS || '21600000', 10), // Default 6 hours for scheduled
  instantCheckIntervalMs: parseInt(process.env.INSTANT_CHECK_INTERVAL_MS || '5000', 10), // 5 seconds
  openservWaitMs: parseInt(process.env.OPENSERV_WAIT_MS || '65000', 10),
  jobRefreshHours: parseInt(process.env.JOB_REFRESH_HOURS || '6', 10), // 6 hours
  londonTimezone: 'Europe/London',
  telegramJobIntervalMs: parseInt(process.env.TELEGRAM_JOB_INTERVAL_MS || '1000', 10), // 1 second
  telegramSendIntervalHours: parseInt(process.env.TELEGRAM_SEND_INTERVAL_HOURS || '6', 10), // Based on content refresh
  port: process.env.PORT || 3001,
};

for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') {
        if (key !== 'openservConnectSid') {
        } else if (key === 'openservConnectSid' && (!value || value.length < 5)) {
        }
    }
    if((key.startsWith('openservWorkspaceId') || key.startsWith('openservAgentId')) && typeof value === 'string' && isNaN(parseInt(value, 10))) {
        console.error(`Error: Environment variable for ${key} ('${value}') must be a number.`);
        process.exit(1);
    }
     if((key.endsWith('IntervalMs') || key.endsWith('WaitMs') || key.endsWith('Hours')) && typeof value === 'number' && isNaN(value)) {
         console.error(`Error: Environment variable for ${key} ('${value}') must be a number.`);
         process.exit(1);
     }
}

if (!config.supabaseUrl || !config.supabaseServiceKey || !config.openservApiKey ) {
    console.error("Error: Critical environment variables (Supabase URL/Service Key, OpenServ API Key) are missing. Exiting.");
    process.exit(1);
}
if (!config.openservWorkspaceIdTelegram || !config.openservAgentIdTelegram) {
     console.error("Error: Telegram agent/workspace IDs are missing. Exiting.");
     process.exit(1);
}

export default config;
