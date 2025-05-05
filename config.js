import dotenv from 'dotenv';

dotenv.config();

const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  openservApiKey: process.env.OPENSERV_API_KEY,
  openservConnectSid: process.env.OPENSERV_CONNECT_SID, // Optional, for GET requests if needed
  openservAgentId: process.env.OPENSERV_AGENT_ID || '140', // Agent for content generation
  openservWorkspaceIdWatchlist: process.env.OPENSERV_WORKSPACE_ID_WATCHLIST || '3422',
  openservWorkspaceIdSector: process.env.OPENSERV_WORKSPACE_ID_SECTOR || '3420',
  openservWorkspaceIdNarrative: process.env.OPENSERV_WORKSPACE_ID_NARRATIVE || '3421',
  // Removed Telegram specific IDs
  jobIntervalMs: parseInt(process.env.JOB_INTERVAL_MS || '21600000', 10), // Default 6 hours for scheduled
  instantCheckIntervalMs: parseInt(process.env.INSTANT_CHECK_INTERVAL_MS || '5000', 10), // 5 seconds for immediate checks
  openservWaitMs: parseInt(process.env.OPENSERV_WAIT_MS || '65000', 10), // Wait time for OpenServ processing
  jobRefreshHours: parseInt(process.env.JOB_REFRESH_HOURS || '6', 10), // How old content can be before refresh
  londonTimezone: 'Europe/London', // For midnight refresh job
  // Removed Telegram intervals
  port: process.env.PORT || 3001, // Port for the health check server
};

// Validation logic (adjusted for removed keys)
for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') {
        // Allow empty connect.sid initially, but maybe warn if used
        if (key === 'openservConnectSid' && (!value || value.length < 5)) {
             // console.warn(`Warning: Environment variable for ${key} is potentially invalid.`);
        } else if (key !== 'openservConnectSid') {
             // console.warn(`Warning: Environment variable for ${key} is empty or not set.`);
        }
    }
    // Check that Workspace/Agent IDs are numbers
    if((key.startsWith('openservWorkspaceId') || key === 'openservAgentId') && typeof value === 'string' && isNaN(parseInt(value, 10))) {
        console.error(`Error: Environment variable for ${key} ('${value}') must be a number.`);
        process.exit(1);
    }
     // Check that time/interval values are numbers
     if((key.endsWith('IntervalMs') || key.endsWith('WaitMs') || key.endsWith('Hours')) && typeof value === 'number' && isNaN(value)) {
         console.error(`Error: Environment variable for ${key} ('${process.env[key.toUpperCase()]}') results in NaN. Must be a number.`);
         process.exit(1);
     }
}

// Critical checks (adjusted for removed keys)
if (!config.supabaseUrl || !config.supabaseServiceKey || !config.openservApiKey ) {
    console.error("Error: Critical environment variables (Supabase URL/Service Key, OpenServ API Key) are missing. Exiting.");
    process.exit(1);
}
// Ensure the core content generation IDs are present
if (!config.openservAgentId || !config.openservWorkspaceIdWatchlist || !config.openservWorkspaceIdSector || !config.openservWorkspaceIdNarrative) {
     console.error("Error: Core OpenServ Agent/Workspace IDs for content generation are missing. Exiting.");
     process.exit(1);
}


export default config;
