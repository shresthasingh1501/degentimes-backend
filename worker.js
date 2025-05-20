// ================================================
// FILE: worker.js
// ================================================
import http from 'http';
import { supabase } from './supabaseClient.js';
import { processUser, needsScheduledUpdate, needsImmediateUpdate } from './processUser.js';
import { processTelegramUser } from './processTelegramUser.js';
import config from './config.js';

let isScheduledContentJobRunning = false;
let isImmediateContentCheckRunning = false;
let isTelegramJobRunning = false;
let isMidnightRefreshRunning = false;

let scheduledContentTimeoutId = null;
let immediateCheckTimeoutId = null;
let telegramJobTimeoutId = null;
let midnightRefreshTimeoutId = null;

const usersCurrentlyProcessingContent = new Set(); // Lock for processUser calls
const FIVE_MINUTES_MS = 5 * 60 * 1000;

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
            telegramJobRunning: isTelegramJobRunning,
            midnightRefreshRunning: isMidnightRefreshRunning,
            nextScheduledContentRunScheduled: scheduledContentTimeoutId !== null,
            nextImmediateCheckScheduled: immediateCheckTimeoutId !== null,
            nextTelegramRunScheduled: telegramJobTimeoutId !== null,
            nextMidnightRefreshScheduled: midnightRefreshTimeoutId !== null,
            usersProcessingContent: Array.from(usersCurrentlyProcessingContent),
        }));
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
});
server.listen(config.port, () => { console.log(`[HTTP Server] Listening on port ${config.port}`); });
server.on('error', (error) => { console.error('[HTTP Server] Server Error:', error); });


async function runScheduledContentCycle() {
    if (isScheduledContentJobRunning) {
        scheduleNextScheduledContentRun();
        return;
    }
    isScheduledContentJobRunning = true;
    // console.log(`\n============ [ScheduledContentJob ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update') // Base fields for processUser
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for scheduled content:", error.message);
        } else if (users && users.length > 0) {
            for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) continue;
                 if (needsScheduledUpdate(user)) {
                      usersCurrentlyProcessingContent.add(user.user_email);
                      try { await processUser(user); }
                      catch (userError) { console.error(`!!! [ScheduledContentJob] Error processing ${user.user_email}:`, userError.message); }
                      finally { usersCurrentlyProcessingContent.delete(user.user_email); }
                 }
            }
        }
    } catch (cycleError) {
        console.error(`!!! [ScheduledContentJob] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        // console.log(`============ [ScheduledContentJob ${new Date().toISOString()}] Cycle Ended ============`);
        isScheduledContentJobRunning = false;
        scheduleNextScheduledContentRun();
    }
}

function scheduleNextScheduledContentRun() {
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    scheduledContentTimeoutId = setTimeout(runScheduledContentCycle, config.jobIntervalMs);
}


async function runImmediateCheckCycle() {
    if (isImmediateContentCheckRunning) {
        scheduleNextImmediateCheck();
        return;
    }
    isImmediateContentCheckRunning = true;

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update, telegramid, tele_last_sent, telegram_initial_send_scheduled_at') // Added TG related fields
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for immediate check:", error.message);
        } else if (users && users.length > 0) {
             for (const user of users) {
                 // Process content update if needed
                 if (needsImmediateUpdate(user) && !usersCurrentlyProcessingContent.has(user.user_email)) {
                      // console.log(` -> [ImmediateCheck/Content] Triggering update for ${user.user_email}`);
                      usersCurrentlyProcessingContent.add(user.user_email);
                      try { await processUser(user); } // This might update user data, but we use the 'user' var from loop for TG scheduling
                      catch (userError) { console.error(`!!! [ImmediateCheck/Content] Error processing ${user.user_email}:`, userError.message); }
                      finally { usersCurrentlyProcessingContent.delete(user.user_email); }
                 }

                 // Check for initial Telegram send scheduling
                 if (user.telegramid && !user.telegram_initial_send_scheduled_at) {
                    console.log(` -> [ImmediateCheck/TG-Initial] New Telegram ID for ${user.user_email}. Scheduling initial send.`);
                    
                    // Mark as scheduled immediately to prevent re-scheduling in quick succession
                    const { error: updateError } = await supabase
                        .from('user_preferences')
                        .update({ telegram_initial_send_scheduled_at: new Date().toISOString() })
                        .eq('user_email', user.user_email);

                    if (updateError) {
                        console.error(` -> [ImmediateCheck/TG-Initial] Failed to update telegram_initial_send_scheduled_at for ${user.user_email}: ${updateError.message}. Will retry next cycle.`);
                    } else {
                        // Clone user object to pass to timeout, ensuring it has all necessary fields for processTelegramUser
                        const userForTimeout = { ...user }; 
                        setTimeout(async () => {
                            console.log(` -> [TG-Initial Job Execute] Running initial Telegram send for ${userForTimeout.user_email}`);
                            try {
                                // userForTimeout already contains all fields selected in the immediate check cycle
                                await processTelegramUser(userForTimeout, usersCurrentlyProcessingContent, true); // true for isInitialSend
                            } catch (e) {
                                console.error(` -> [TG-Initial Job Execute] Error during initial Telegram send for ${userForTimeout.user_email}: ${e.message}`);
                                // Note: telegram_initial_send_scheduled_at is already set.
                                // If this fails, the "initial" send is missed unless manually reset.
                            }
                        }, FIVE_MINUTES_MS);
                        console.log(` -> [ImmediateCheck/TG-Initial] Scheduled initial Telegram send for ${user.user_email} in 5 minutes.`);
                    }
                 }
             }
        }
    } catch (cycleError) {
        console.error(`!!! [ImmediateCheck] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        isImmediateContentCheckRunning = false;
        scheduleNextImmediateCheck();
    }
}

function scheduleNextImmediateCheck() {
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    immediateCheckTimeoutId = setTimeout(runImmediateCheckCycle, config.instantCheckIntervalMs);
}


async function runTelegramJobCycle() { // This is for REGULAR Telegram sends
     if (isTelegramJobRunning) {
         scheduleNextTelegramRun();
         return;
     }
     isTelegramJobRunning = true;
     // console.log(`\n============ [TelegramJob REGULAR ${new Date().toISOString()}] Starting Cycle ============`);

     try {
         const { data: users, error } = await supabase
             .from('user_preferences')
             .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro, last_job') // Fields needed by processTelegramUser
             .eq('ispro', true)
             .not('telegramid', 'is', null);

         if (error) {
             console.error(" -> Error fetching users for REGULAR Telegram:", error.message);
         } else if (users && users.length > 0) {
             for (const user of users) {
                 try {
                     // Call with isInitialSend = false (default) for regular jobs
                     await processTelegramUser(user, usersCurrentlyProcessingContent);
                 }
                 catch (userError) { console.error(`!!! [TelegramJob REGULAR] Error processing Telegram for ${user.user_email}:`, userError.message); }
             }
         }
     } catch (cycleError) {
         console.error(`!!! [TelegramJob REGULAR] Critical error during cycle:`, cycleError.message, cycleError.stack);
     } finally {
        //  console.log(`============ [TelegramJob REGULAR ${new Date().toISOString()}] Cycle Ended ============`);
         isTelegramJobRunning = false;
         scheduleNextTelegramRun();
     }
 }

 function scheduleNextTelegramRun() {
     if (telegramJobTimeoutId) clearTimeout(telegramJobTimeoutId);
     telegramJobTimeoutId = setTimeout(runTelegramJobCycle, config.telegramJobIntervalMs);
 }


async function runMidnightRefresh() {
    if (isMidnightRefreshRunning) {
        scheduleNextMidnightRefresh();
        return;
    }
    isMidnightRefreshRunning = true;
    console.log(`\n============ [MidnightRefresh ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for midnight refresh:", error.message);
        } else if (users && users.length > 0) {
             console.log(` -> Found ${users.length} Pro users for midnight refresh.`);
             const processingPromises = users.map(async (user) => {
                  if (usersCurrentlyProcessingContent.has(user.user_email)) {
                       console.log(` -> [MidnightRefresh] Skipping ${user.user_email}, already processing.`);
                       return;
                  }
                  usersCurrentlyProcessingContent.add(user.user_email);
                  try {
                       await processUser(user, true);
                  } catch (userError) {
                       console.error(`!!! [MidnightRefresh] Error processing ${user.user_email}:`, userError.message);
                  } finally {
                       usersCurrentlyProcessingContent.delete(user.user_email);
                  }
             });
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
        scheduleNextMidnightRefresh();
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

    console.log(`[Scheduler] Scheduling next Midnight Refresh in ${Math.round(msUntilMidnight / 1000 / 60)} minutes (at ${londonTomorrowMidnight.toLocaleString()})`);
    midnightRefreshTimeoutId = setTimeout(runMidnightRefresh, msUntilMidnight);
}


console.log("Starting DegenTimes Worker Process...");
console.log(` - Scheduled Content Job Interval: ${config.jobIntervalMs / 1000}s (${config.jobRefreshHours} hours)`);
console.log(` - Immediate Content Check Interval: ${config.instantCheckIntervalMs / 1000}s`);
console.log(` - Telegram REGULAR Job Interval: ${config.telegramJobIntervalMs / 1000}s (checks if any user needs regular send)`);
console.log(` - Telegram Initial Send Delay: ${FIVE_MINUTES_MS / 1000}s (upon new Telegram ID)`);
console.log(` - Telegram Send Cooldown (Regular): ${config.telegramSendIntervalHours} hours`);
console.log(` - Midnight Refresh Timezone: ${config.londonTimezone}`);

runScheduledContentCycle();
runImmediateCheckCycle();
runTelegramJobCycle(); // For regular sends
scheduleNextMidnightRefresh();

function shutdown(signal) {
    console.log(`[Process] ${signal} signal received. Shutting down gracefully.`);
    server.close(() => { console.log('[HTTP Server] Closed.'); });
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    if (telegramJobTimeoutId) clearTimeout(telegramJobTimeoutId);
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);
    // Note: active 5-minute timeouts for initial TG sends will be lost on shutdown
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
