import http from 'http';
import { supabase } from './supabaseClient.js';
import { processUser, needsScheduledUpdate, needsImmediateUpdate } from './processUser.js';
// Removed import { processTelegramUser } from './processTelegramUser.js';
import config from './config.js';

// State variables for content jobs
let isScheduledContentJobRunning = false;
let isImmediateContentCheckRunning = false;
let isMidnightRefreshRunning = false;
// Removed isTelegramJobRunning

// Timeout IDs for scheduling
let scheduledContentTimeoutId = null;
let immediateCheckTimeoutId = null;
let midnightRefreshTimeoutId = null;
// Removed telegramJobTimeoutId

// Lock to prevent concurrent processing for the same user
const usersCurrentlyProcessingContent = new Set();

// Simple HTTP server for health checks
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
            // Removed telegramJobRunning
            midnightRefreshRunning: isMidnightRefreshRunning,
            nextScheduledContentRunScheduled: scheduledContentTimeoutId !== null,
            nextImmediateCheckScheduled: immediateCheckTimeoutId !== null,
            // Removed nextTelegramRunScheduled
            nextMidnightRefreshScheduled: midnightRefreshTimeoutId !== null,
            usersProcessingContent: Array.from(usersCurrentlyProcessingContent),
        }));
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
});
server.listen(config.port, () => { console.log(`[HTTP Server] Listening on port ${config.port}`); });
server.on('error', (error) => { console.error('[HTTP Server] Server Error:', error); });


// --- Scheduled Content Processing Cycle ---
async function runScheduledContentCycle() {
    if (isScheduledContentJobRunning) {
        scheduleNextScheduledContentRun();
        return;
    }
    isScheduledContentJobRunning = true;
    console.log(`\n============ [ScheduledContentJob ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        // Select fields needed for processUser and its checks
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true); // Only process Pro users

        if (error) {
            console.error("[ScheduledContentJob] Error fetching users:", error.message);
        } else if (users && users.length > 0) {
            console.log(`[ScheduledContentJob] Found ${users.length} Pro users to check.`);
            for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) {
                     // console.log(`[ScheduledContentJob] Skipping ${user.user_email}, already processing.`);
                     continue; // Skip if already being processed (e.g., by immediate check)
                 }
                 // Check if this user needs a scheduled update
                 if (needsScheduledUpdate(user)) {
                      usersCurrentlyProcessingContent.add(user.user_email); // Lock user processing
                      try {
                          console.log(`[ScheduledContentJob] Processing ${user.user_email}...`);
                          await processUser(user); // Process the user's content
                      } catch (userError) {
                          // Catch errors specific to this user's processing
                          console.error(`!!! [ScheduledContentJob] Error processing ${user.user_email}:`, userError.message);
                      } finally {
                          usersCurrentlyProcessingContent.delete(user.user_email); // Unlock user processing
                      }
                 }
            }
            console.log(`[ScheduledContentJob] Finished checking users.`);
        } else {
            console.log("[ScheduledContentJob] No Pro users found.");
        }
    } catch (cycleError) {
        // Catch critical errors in the overall cycle (e.g., Supabase connection)
        console.error(`!!! [ScheduledContentJob] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        console.log(`============ [ScheduledContentJob ${new Date().toISOString()}] Cycle Ended ============`);
        isScheduledContentJobRunning = false;
        scheduleNextScheduledContentRun(); // Schedule the next run
    }
}

function scheduleNextScheduledContentRun() {
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    console.log(`[Scheduler] Scheduling next Scheduled Content Job in ${config.jobIntervalMs / 1000 / 60} minutes.`);
    scheduledContentTimeoutId = setTimeout(runScheduledContentCycle, config.jobIntervalMs);
}


// --- Immediate Content Check Cycle ---
async function runImmediateCheckCycle() {
    if (isImmediateContentCheckRunning) {
        scheduleNextImmediateCheck();
        return;
    }
    isImmediateContentCheckRunning = true;
    // No start/end logs for this frequent check unless debugging

    try {
        // Select fields needed for processUser and its checks
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true); // Only process Pro users

        if (error) {
            console.error("[ImmediateCheck] Error fetching users:", error.message);
        } else if (users && users.length > 0) {
             for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) {
                    // console.log(`[ImmediateCheck] Skipping ${user.user_email}, already processing.`);
                    continue; // Skip if already being processed
                 }
                 // Check if this user needs an immediate update (new prefs, missing content)
                 if (needsImmediateUpdate(user)) {
                      console.log(` -> [ImmediateCheck] Triggering update for ${user.user_email}`);
                      usersCurrentlyProcessingContent.add(user.user_email); // Lock user processing
                      try {
                          // console.log(`[ImmediateCheck] Processing ${user.user_email}...`);
                          await processUser(user); // Process the user's content
                      } catch (userError) {
                           console.error(`!!! [ImmediateCheck] Error processing ${user.user_email}:`, userError.message);
                      } finally {
                           usersCurrentlyProcessingContent.delete(user.user_email); // Unlock user processing
                      }
                 }
             }
        }
    } catch (cycleError) {
        console.error(`!!! [ImmediateCheck] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        isImmediateContentCheckRunning = false;
        scheduleNextImmediateCheck(); // Schedule the next check
    }
}

function scheduleNextImmediateCheck() {
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    // No logging for this frequent schedule
    immediateCheckTimeoutId = setTimeout(runImmediateCheckCycle, config.instantCheckIntervalMs);
}

// --- Removed Telegram Job Cycle ---


// --- Midnight Refresh Cycle (Force updates for all Pro users) ---
async function runMidnightRefresh() {
    if (isMidnightRefreshRunning) {
        scheduleNextMidnightRefresh(); // Reschedule anyway
        return;
    }
    isMidnightRefreshRunning = true;
    console.log(`\n============ [MidnightRefresh ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        // Select all fields needed by processUser
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true); // Only refresh Pro users

        if (error) {
            console.error(" -> Error fetching users for midnight refresh:", error.message);
        } else if (users && users.length > 0) {
             console.log(` -> Found ${users.length} Pro users for midnight refresh.`);
             // Process users concurrently, managing locks
             const processingPromises = users.map(async (user) => {
                  if (usersCurrentlyProcessingContent.has(user.user_email)) {
                       console.log(` -> [MidnightRefresh] Skipping ${user.user_email}, already processing.`);
                       return; // Skip if locked (e.g., by immediate check)
                  }
                  usersCurrentlyProcessingContent.add(user.user_email); // Lock before async call
                  try {
                       console.log(` -> [MidnightRefresh] Force-processing ${user.user_email}...`);
                       await processUser(user, true); // Force run processUser
                  } catch (userError) {
                       console.error(`!!! [MidnightRefresh] Error processing ${user.user_email}:`, userError.message);
                  } finally {
                       usersCurrentlyProcessingContent.delete(user.user_email); // Unlock in finally
                  }
             });
             // Wait for all processing attempts to settle
             await Promise.allSettled(processingPromises);
             console.log(` -> Finished midnight refresh processing loop.`);
        } else {
             console.log(" -> No Pro users found for midnight refresh.");
        }
    } catch (cycleError) {
        console.error(`!!! [MidnightRefresh] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        console.log(`============ [MidnightRefresh ${new Date().toISOString()}] Cycle Ended ============`);
        isMidnightRefreshRunning = false;
        scheduleNextMidnightRefresh(); // Schedule the next midnight run
    }
}

function scheduleNextMidnightRefresh() {
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);

    const now = new Date();
    // Get current time in London
    const londonNow = new Date(now.toLocaleString('en-US', { timeZone: config.londonTimezone }));

    // Calculate next midnight in London
    const londonTomorrowMidnight = new Date(londonNow);
    londonTomorrowMidnight.setDate(londonTomorrowMidnight.getDate() + 1);
    londonTomorrowMidnight.setHours(0, 0, 0, 0);

    // Calculate delay from London's current time to London's next midnight
    const msUntilMidnight = londonTomorrowMidnight.getTime() - londonNow.getTime();

    console.log(`[Scheduler] Scheduling next Midnight Refresh in ${Math.round(msUntilMidnight / 1000 / 60)} minutes (at ${londonTomorrowMidnight.toLocaleString()})`);
    midnightRefreshTimeoutId = setTimeout(runMidnightRefresh, msUntilMidnight);
}


// --- Worker Initialization ---
console.log("Starting DegenTimes Content Worker Process...");
console.log(` - Scheduled Content Job Interval: ${config.jobIntervalMs / 1000}s (${config.jobRefreshHours} hours)`);
console.log(` - Immediate Content Check Interval: ${config.instantCheckIntervalMs / 1000}s`);
// Removed Telegram logs
console.log(` - Midnight Refresh Timezone: ${config.londonTimezone}`);

// Start the job cycles
runScheduledContentCycle();
runImmediateCheckCycle();
// Removed runTelegramJobCycle();
scheduleNextMidnightRefresh(); // Initial schedule for midnight

// --- Graceful Shutdown ---
function shutdown(signal) {
    console.log(`[Process] ${signal} signal received. Shutting down gracefully...`);
    server.close(() => { console.log('[HTTP Server] Closed.'); });

    // Clear all scheduled timeouts
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    // Removed telegramJobTimeoutId clear
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);

    // Allow time for current operations to potentially finish (optional)
    console.log("[Process] Waiting briefly before exit...");
    setTimeout(() => {
        console.log("[Process] Exiting.");
        process.exit(0);
    }, 1500); // Wait 1.5 seconds
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
