// config.js
import dotenv from 'dotenv';

dotenv.config();

const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  openservApiKey: process.env.OPENSERV_API_KEY,
  openservConnectSid: process.env.OPENSERV_CONNECT_SID,
  // Content Gen IDs
  openservAgentId: process.env.OPENSERV_AGENT_ID || '140',
  openservWorkspaceIdWatchlist: process.env.OPENSERV_WORKSPACE_ID_WATCHLIST || '3422',
  openservWorkspaceIdSector: process.env.OPENSERV_WORKSPACE_ID_SECTOR || '3420',
  openservWorkspaceIdNarrative: process.env.OPENSERV_WORKSPACE_ID_NARRATIVE || '3421',
  // Telegram Send IDs
  openservWorkspaceIdTelegram: process.env.OPENSERV_WORKSPACE_ID_TELEGRAM || '3416', // Added
  openservAgentIdTelegram: process.env.OPENSERV_AGENT_ID_TELEGRAM || '267',         // Added
  // Content Gen Timing
  jobIntervalMs: parseInt(process.env.JOB_INTERVAL_MS || '60000', 10),
  openservWaitMs: parseInt(process.env.OPENSERV_WAIT_MS || '65000', 10),
  jobRefreshHours: parseInt(process.env.JOB_REFRESH_HOURS || '24', 10),
  // Telegram Send Timing
  telegramJobIntervalMs: parseInt(process.env.TELEGRAM_JOB_INTERVAL_MS || '300000', 10), // Added (5 min default)
  telegramSendIntervalHours: parseInt(process.env.TELEGRAM_SEND_INTERVAL_HOURS || '24', 10), // Added
  // Server Port
  port: process.env.PORT || 3001,
};

// Basic validation (added checks for new variables)
for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') {
        if (key !== 'openservConnectSid') {
           console.warn(`Warning: Environment variable for ${key} is missing or empty.`);
        } else if (key === 'openservConnectSid' && (!value || value.length < 5)) {
            console.warn(`Warning: OPENSERV_CONNECT_SID seems missing or very short.`);
        }
    }
    if((key.startsWith('openservWorkspaceId') || key.startsWith('openservAgentId')) && isNaN(parseInt(value, 10))) {
        console.error(`Error: Environment variable for ${key} ('${value}') must be a number.`);
        process.exit(1);
    }
     if((key.endsWith('IntervalMs') || key.endsWith('WaitMs') || key.endsWith('Hours')) && isNaN(parseInt(value, 10))) {
         console.error(`Error: Environment variable for ${key} ('${value}') must be a number.`);
         process.exit(1);
     }
}

// Critical checks
if (!config.supabaseUrl || !config.supabaseServiceKey || !config.openservApiKey ) {
    console.error("Error: Critical environment variables (Supabase URL/Service Key, OpenServ API Key) are missing. Exiting.");
    process.exit(1);
}
if (!config.openservWorkspaceIdTelegram || !config.openservAgentIdTelegram) {
     console.error("Error: Telegram agent/workspace IDs are missing. Exiting.");
     process.exit(1);
}


export default config;
