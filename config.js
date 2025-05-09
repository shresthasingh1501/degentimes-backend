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

  openservTwitterApiKey: process.env.OPENSERV_TWITTER_API_KEY,
  openservTwitterConnectSid: process.env.OPENSERV_TWITTER_CONNECT_SID,
  openservTwitterAgentId: process.env.OPENSERV_TWITTER_AGENT_ID,
  openservTwitterWorkspaceIdWatchlistLatest: process.env.OPENSERV_TWITTER_WORKSPACE_ID_WATCHLIST_LATEST,
  openservTwitterWorkspaceIdWatchlistTop: process.env.OPENSERV_TWITTER_WORKSPACE_ID_WATCHLIST_TOP,
  openservTwitterWorkspaceIdSectorLatest: process.env.OPENSERV_TWITTER_WORKSPACE_ID_SECTOR_LATEST,
  openservTwitterWorkspaceIdSectorTop: process.env.OPENSERV_TWITTER_WORKSPACE_ID_SECTOR_TOP,
  openservTwitterWorkspaceIdNarrativeLatest: process.env.OPENSERV_TWITTER_WORKSPACE_ID_NARRATIVE_LATEST,
  openservTwitterWorkspaceIdNarrativeTop: process.env.OPENSERV_TWITTER_WORKSPACE_ID_NARRATIVE_TOP,

  openservTelegramAgentId: process.env.OPENSERV_TELEGRAM_AGENT_ID,
  openservTelegramWorkspaceId: process.env.OPENSERV_TELEGRAM_WORKSPACE_ID,

  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModelId: process.env.GEMINI_MODEL_ID || 'gemini-1.5-flash-latest',

  jobIntervalMs: parseInt(process.env.JOB_INTERVAL_MS || '21600000', 10),
  instantCheckIntervalMs: parseInt(process.env.INSTANT_CHECK_INTERVAL_MS || '5000', 10),
  openservWaitMs: parseInt(process.env.OPENSERV_WAIT_MS || '65000', 10),
  jobRefreshHours: parseInt(process.env.JOB_REFRESH_HOURS || '6', 10),
  telegramSendIntervalHours: parseInt(process.env.TELEGRAM_SEND_INTERVAL_HOURS || '14', 10),
  telegramPostDelayMs: parseInt(process.env.TELEGRAM_POST_DELAY_MS || '30000', 10),

  londonTimezone: 'Europe/London',
  port: process.env.PORT || 3001,
  placeholderMessagePrefix: "Please Select A Preference",
  errorFetchingPrefix: "Error fetching",
  socialPlaceholderPrefix: "Social media insights",
  socialErrorMessagePrefix: "Could not retrieve social",
};


function validateNumericString(key, value, isOptional = false) {
    if (value === undefined || value === null || value === '') {
        if (!isOptional) {
            console.warn(`Warning: Environment variable for ${key} is empty or not set and is recommended.`);
        }
        return;
    }
    if (typeof value === 'string' && isNaN(parseInt(value, 10))) {
        console.error(`Error: Environment variable for ${key} ('${value}') must be a number string.`);
        process.exit(1);
    }
}

function validateNonEmptyString(key, value, isOptional = false, minLength = 1) {
    if (value === undefined || value === null || value === '') {
        if (!isOptional) {
            console.error(`Error: Environment variable for ${key} is empty or not set and is required.`);
            process.exit(1);
        }
        return;
    }
    if (typeof value !== 'string' || value.length < minLength) {
        console.error(`Error: Environment variable for ${key} ('${value}') must be a string with minimum length ${minLength}.`);
        process.exit(1);
    }
}

validateNonEmptyString('SUPABASE_URL', config.supabaseUrl);
validateNonEmptyString('SUPABASE_SERVICE_KEY', config.supabaseServiceKey, false, 20);
validateNonEmptyString('OPENSERV_API_KEY', config.openservApiKey, false, 10);
validateNonEmptyString('OPENSERV_CONNECT_SID', config.openservConnectSid, true, 5);

validateNumericString('OPENSERV_AGENT_ID', config.openservAgentId);
validateNumericString('OPENSERV_WORKSPACE_ID_WATCHLIST', config.openservWorkspaceIdWatchlist);
validateNumericString('OPENSERV_WORKSPACE_ID_SECTOR', config.openservWorkspaceIdSector);
validateNumericString('OPENSERV_WORKSPACE_ID_NARRATIVE', config.openservWorkspaceIdNarrative);

const twitterApiKeyPresent = !!config.openservTwitterApiKey;
if (twitterApiKeyPresent) {
    validateNonEmptyString('OPENSERV_TWITTER_CONNECT_SID', config.openservTwitterConnectSid, false, 5);
    validateNumericString('OPENSERV_TWITTER_AGENT_ID', config.openservTwitterAgentId, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_WATCHLIST_LATEST', config.openservTwitterWorkspaceIdWatchlistLatest, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_WATCHLIST_TOP', config.openservTwitterWorkspaceIdWatchlistTop, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_SECTOR_LATEST', config.openservTwitterWorkspaceIdSectorLatest, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_SECTOR_TOP', config.openservTwitterWorkspaceIdSectorTop, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_NARRATIVE_LATEST', config.openservTwitterWorkspaceIdNarrativeLatest, false);
    validateNumericString('OPENSERV_TWITTER_WORKSPACE_ID_NARRATIVE_TOP', config.openservTwitterWorkspaceIdNarrativeTop, false);
} else {
    console.info("INFO: OPENSERV_TWITTER_API_KEY not set. Twitter integration will be skipped.");
}

const telegramConfigPresent = !!(config.openservTelegramAgentId || config.openservTelegramWorkspaceId);
if (telegramConfigPresent) {
    console.info("INFO: Telegram agent/workspace ID detected. Enabling Telegram features.");
    validateNumericString('OPENSERV_TELEGRAM_AGENT_ID', config.openservTelegramAgentId, false);
    validateNumericString('OPENSERV_TELEGRAM_WORKSPACE_ID', config.openservTelegramWorkspaceId, false);
} else {
     console.info("INFO: OPENSERV_TELEGRAM_AGENT_ID or OPENSERV_TELEGRAM_WORKSPACE_ID not set. Telegram sending will be skipped.");
}

const geminiApiKeyPresent = !!config.geminiApiKey;
if (geminiApiKeyPresent) {
    validateNonEmptyString('GEMINI_MODEL_ID', config.geminiModelId, false);
} else {
    console.info("INFO: GEMINI_API_KEY not set. Gemini AI insights will be skipped.");
}

config.openservAgentId = parseInt(config.openservAgentId, 10);
config.openservWorkspaceIdWatchlist = parseInt(config.openservWorkspaceIdWatchlist, 10);
config.openservWorkspaceIdSector = parseInt(config.openservWorkspaceIdSector, 10);
config.openservWorkspaceIdNarrative = parseInt(config.openservWorkspaceIdNarrative, 10);

if (twitterApiKeyPresent) {
    config.openservTwitterAgentId = parseInt(config.openservTwitterAgentId, 10);
    config.openservTwitterWorkspaceIdWatchlistLatest = parseInt(config.openservTwitterWorkspaceIdWatchlistLatest, 10);
    config.openservTwitterWorkspaceIdWatchlistTop = parseInt(config.openservTwitterWorkspaceIdWatchlistTop, 10);
    config.openservTwitterWorkspaceIdSectorLatest = parseInt(config.openservTwitterWorkspaceIdSectorLatest, 10);
    config.openservTwitterWorkspaceIdSectorTop = parseInt(config.openservTwitterWorkspaceIdSectorTop, 10);
    config.openservTwitterWorkspaceIdNarrativeLatest = parseInt(config.openservTwitterWorkspaceIdNarrativeLatest, 10);
    config.openservTwitterWorkspaceIdNarrativeTop = parseInt(config.openservTwitterWorkspaceIdNarrativeTop, 10);
}

if (telegramConfigPresent) {
    config.openservTelegramAgentId = parseInt(config.openservTelegramAgentId, 10);
    config.openservTelegramWorkspaceId = parseInt(config.openservTelegramWorkspaceId, 10);
}

['jobIntervalMs', 'instantCheckIntervalMs', 'openservWaitMs', 'jobRefreshHours', 'telegramSendIntervalHours', 'telegramPostDelayMs'].forEach(key => {
    if (isNaN(config[key])) {
        console.error(`Error: Configured value for ${key} ('${process.env[key.toUpperCase()]}') results in NaN. Must be a number.`);
        process.exit(1);
    }
});

export default config;
