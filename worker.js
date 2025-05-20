import http from 'http';
import { supabase } from './supabaseClient.js';
import { processUser, needsScheduledUpdate, needsImmediateUpdate } from './processUser.js';
import config from './config.js';

// --- State Variables --- // Ensure these are at the top level
let isScheduledContentJobRunning = false;
let isImmediateContentCheckRunning = false;
let isMidnightRefreshRunning = false;

let scheduledContentTimeoutId = null;
let immediateCheckTimeoutId = null;
let midnightRefreshTimeoutId = null;

const usersCurrentlyProcessingContent = new Set();

// --- HTTP Server Setup ---
console.log("[Startup] Initializing HTTP server..."); // Log: Server init start
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('pong');
    } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            scheduledContentJobRunning: isScheduledContentJobRunning,
            immediateContentCheckRunning: isImmediateContentCheckRunning,
            midnightRefreshRunning: isMidnightRefreshRunning,
            nextScheduledContentRunScheduled: scheduledContentTimeoutId !== null,
            nextImmediateCheckScheduled: immediateCheckTimeoutId !== null,
            nextMidnightRefreshScheduled: midnightRefreshTimeoutId !== null,
            usersProcessingContent: Array.from(usersCurrentlyProcessingContent),
            twitterIntegrationEnabled: !!(config.openservTwitterApiKey && config.openservTwitterAgentId && config.openservTwitterConnectSid),
            geminiIntegrationEnabled: !!config.geminiApiKey,
            telegramIntegrationEnabled: !!(config.openservTelegramAgentId && config.openservTelegramWorkspaceId),
        }));
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
});

server.on('error', (error) => { // Catch server errors
    console.error('[HTTP Server] Critical Server Error:', error);
    // Consider exiting if the server fails critically
    // process.exit(1);
});

server.on('listening', () => { // Log: Explicit confirmation
    console.log(`[HTTP Server] Successfully listening on port ${config.port}`);
});

// --- Database Columns ---
const USER_COLUMNS_TO_SELECT = [
    'user_email', 'preferences', 'ispro',
    'last_job', 'ai_last_update', 'preference_update',
    'telegramid', 'tele_last_sent',
    'watchlist', 'sector', 'narrative',
    'watchlist_intel', 'sector_intel', 'narrative_intel',
    'watchlist_social', 'sector_social', 'narrative_social'
].join(', ');

// --- Job Cycle Functions ---

async function runScheduledContentCycle() {
    console.log("[ScheduledContentJob] Cycle function entered."); // Log: Cycle Start
    if (isScheduledContentJobRunning) {
        console.log("[ScheduledContentJob] Already running, rescheduling.");
        scheduleNextScheduledContentRun();
        return;
    }
    isScheduledContentJobRunning = true;
    console.log(`\n============ [ScheduledContentJob ${new Date().toISOString()}] Starting ============`);
    try {
        console.log("[ScheduledContentJob] Fetching users..."); // Log: Inside Try
        const { data: users, error } = await supabase.from('user_preferences').select(USER_COLUMNS_TO_SELECT).eq('ispro', true);
        if (error) {
            console.error("[ScheduledContentJob] Error fetching users:", error.message);
        } else if (users && users.length > 0) {
            console.log(`[ScheduledContentJob] Found ${users.length} Pro users to check.`);
            for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) {
                     continue;
                 }
                 if (needsScheduledUpdate(user)) {
                      usersCurrentlyProcessingContent.add(user.user_email);
                      try {
                          console.log(`[ScheduledContentJob] Calling processUser for ${user.user_email}...`); // Log: Before processUser call
                          await processUser(user, false, "Scheduled Update");
                          console.log(`[ScheduledContentJob] processUser finished for ${user.user_email}.`); // Log: After processUser call
                      }
                      catch (userError) { console.error(`!!! [ScheduledJob] Error processing ${user.user_email}:`, userError.message, userError.stack); }
                      finally {
                          usersCurrentlyProcessingContent.delete(user.user_email);
                      }
                 }
            }
             console.log("[ScheduledContentJob] Finished user loop."); // Log: After Loop
        } else console.log("[ScheduledContentJob] No Pro users found.");
    } catch (cycleError) { console.error(`!!! [ScheduledJob] Critical cycle error:`, cycleError.message, cycleError.stack); }
    finally {
        console.log(`============ [ScheduledContentJob ${new Date().toISOString()}] Ended - Scheduling next run... ============`); // Log: Finally Start
        isScheduledContentJobRunning = false;
        scheduleNextScheduledContentRun(); // Schedule next
    }
}

function scheduleNextScheduledContentRun() {
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    console.log(`[Scheduler] Scheduling next Scheduled Content Job in ${config.jobIntervalMs / 1000 / 60} minutes.`); // Log: Scheduling
    scheduledContentTimeoutId = setTimeout(runScheduledContentCycle, config.jobIntervalMs);
}

async function runImmediateCheckCycle() {
    // console.log("[ImmediateCheck] Cycle function entered."); // Can be too noisy, enable if needed
    if (isImmediateContentCheckRunning) {
        // console.log("[ImmediateCheck] Already running, rescheduling.");
        scheduleNextImmediateCheck();
        return;
    }
    isImmediateContentCheckRunning = true;
    try {
        const { data: users, error } = await supabase.from('user_preferences').select(USER_COLUMNS_TO_SELECT).eq('ispro', true);
        if (error) {
             console.error("[ImmediateCheck] Error fetching users:", error.message);
        } else if (users && users.length > 0) {
             for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) continue;
                 if (needsImmediateUpdate(user)) {
                      usersCurrentlyProcessingContent.add(user.user_email);
                      try {
                          // console.log(` -> [ImmediateCheck] Calling processUser for ${user.user_email}`); // Log: Before processUser call
                          await processUser(user, false, "Immediate Update");
                          // console.log(` -> [ImmediateCheck] processUser finished for ${user.user_email}.`); // Log: After processUser call
                      }
                      catch (userError) { console.error(`!!! [ImmediateCheck] Error processing ${user.user_email}:`, userError.message, userError.stack); }
                      finally {
                          usersCurrentlyProcessingContent.delete(user.user_email);
                      }
                 }
             }
        }
    } catch (cycleError) { console.error(`!!! [ImmediateCheck] Critical cycle error:`, cycleError.message, cycleError.stack); }
    finally {
        // console.log("[ImmediateCheck] Cycle ended - Scheduling next run."); // Can be too noisy
        isImmediateContentCheckRunning = false;
        scheduleNextImmediateCheck(); // Schedule next
    }
}

function scheduleNextImmediateCheck() {
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    // console.log("[Scheduler] Scheduling next Immediate Check."); // Noisy
    immediateCheckTimeoutId = setTimeout(runImmediateCheckCycle, config.instantCheckIntervalMs);
}

async function runMidnightRefresh() {
    console.log("[MidnightRefresh] Cycle function entered."); // Log: Cycle Start
    if (isMidnightRefreshRunning) {
        console.log("[MidnightRefresh] Already running, rescheduling.");
        scheduleNextMidnightRefresh();
        return;
    }
    isMidnightRefreshRunning = true;
    console.log(`\n============ [MidnightRefresh ${new Date().toISOString()}] Starting ============`);
    try {
        console.log("[MidnightRefresh] Fetching users..."); // Log: Inside Try
        const { data: users, error } = await supabase.from('user_preferences').select(USER_COLUMNS_TO_SELECT).eq('ispro', true);
        if (error) {
            console.error("[MidnightRefresh] Error fetching users:", error.message);
        } else if (users && users.length > 0) {
             console.log(`[MidnightRefresh] Found ${users.length} Pro users for refresh.`);
             const promises = users.map(async (user) => {
                  if (usersCurrentlyProcessingContent.has(user.user_email)) {
                      return;
                  }
                  usersCurrentlyProcessingContent.add(user.user_email);
                  try {
                       console.log(`[MidnightRefresh] Calling processUser (forced) for ${user.user_email}...`); // Log: Before processUser call
                       await processUser(user, true);
                       console.log(`[MidnightRefresh] processUser finished for ${user.user_email}.`); // Log: After processUser call
                  }
                  catch (userError) { console.error(`!!! [MidnightRefresh] Error processing ${user.user_email}:`, userError.message, userError.stack); }
                  finally {
                       usersCurrentlyProcessingContent.delete(user.user_email);
                  }
             });
             await Promise.allSettled(promises);
             console.log("[MidnightRefresh] Finished user loop processing."); // Log: After Loop
        } else console.log("[MidnightRefresh] No Pro users found.");
    } catch (cycleError) { console.error(`!!! [MidnightRefresh] Critical cycle error:`, cycleError.message, cycleError.stack); }
    finally {
        console.log(`============ [MidnightRefresh ${new Date().toISOString()}] Ended - Scheduling next run... ============`); // Log: Finally Start
        isMidnightRefreshRunning = false;
        scheduleNextMidnightRefresh(); // Schedule next
    }
}

function scheduleNextMidnightRefresh() {
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);
    const now = new Date();
    const londonNow = new Date(now.toLocaleString('en-US', { timeZone: config.londonTimezone }));
    const londonTomorrowMidnight = new Date(londonNow);
    londonTomorrowMidnight.setDate(londonTomorrowMidnight.getDate() + 1);
    londonTomorrowMidnight.setHours(0, 0, 0, 0);
    const msUntilMidnight = londonTomorrowMidnight.getTime() - londonNow.getTime();
    console.log(`[Scheduler] Scheduling next Midnight Refresh in ${Math.round(msUntilMidnight / 1000 / 60)} minutes.`); // Log: Scheduling
    midnightRefreshTimeoutId = setTimeout(runMidnightRefresh, msUntilMidnight);
}

// --- Worker Initialization ---
console.log("[Startup] Starting DegenTimes Content Worker Process...");
console.log(` - Scheduled Job Interval: ${config.jobIntervalMs / 1000}s`);
console.log(` - Immediate Check Interval: ${config.instantCheckIntervalMs / 1000}s`);
if (config.openservTwitterApiKey) console.log(` - Twitter Social Processing: ENABLED`); else console.log(` - Twitter Social Processing: DISABLED`);
if (config.geminiApiKey) console.log(` - Gemini AI Insights: ENABLED (Model: ${config.geminiModelId})`); else console.log(` - Gemini AI Insights: DISABLED`);
if (config.openservTelegramAgentId && config.openservTelegramWorkspaceId) console.log(` - Telegram Sending: ENABLED (Agent: ${config.openservTelegramAgentId}, WS: ${config.openservTelegramWorkspaceId}, Interval: ${config.telegramSendIntervalHours}h)`); else console.log(` - Telegram Sending: DISABLED`);

console.log("[Startup] Starting HTTP server listener..."); // Log: Before server listen
server.listen(config.port); // Initiate listen

console.log("[Startup] Initiating first job cycles..."); // Log: Before initial calls
try {
    runScheduledContentCycle(); // Starts the first cycle immediately
    runImmediateCheckCycle(); // Starts the first cycle immediately
    scheduleNextMidnightRefresh(); // Schedules the first midnight run
    console.log("[Startup] Initial job cycles initiated."); // Log: After initial calls
} catch (startupError) {
    console.error("!!! [Startup] Error during initial job cycle initiation:", startupError);
    process.exit(1); // Exit if startup calls fail critically
}

// --- Graceful Shutdown ---
function shutdown(signal) {
    console.log(`[Process] ${signal} received. Shutting down...`);
    server.close((err) => { // Add error handling for server close
        if (err) {
            console.error('[HTTP Server] Error closing server:', err);
        } else {
            console.log('[HTTP Server] Closed.');
        }
     });
    clearTimeout(scheduledContentTimeoutId); clearTimeout(immediateCheckTimeoutId); clearTimeout(midnightRefreshTimeoutId);
    console.log("[Process] Cleared timers. Waiting briefly before exit...");
    setTimeout(() => { console.log("[Process] Exiting."); process.exit(0); }, 2500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('!!! [Process] Unhandled Rejection at:', promise, 'reason:', reason);
  // process.exit(1); // Consider exiting
});
process.on('uncaughtException', (error) => {
  console.error('!!! [Process] Uncaught Exception:', error);
  process.exit(1); // Strongly recommended to exit
});

console.log("[Startup] Event loop should now be active with server and timers."); // Log: End of synchronous code
