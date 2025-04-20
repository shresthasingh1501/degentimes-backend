// worker.js
import http from 'http';
import { supabase } from './supabaseClient.js';
import { processUser } from './processUser.js'; // For content generation
import { processTelegramUser } from './processTelegramUser.js'; // For Telegram sending
import config from './config.js';

let isContentJobRunning = false; // Prevent overlapping content job runs
let isTelegramJobRunning = false; // Prevent overlapping telegram job runs
let contentJobTimeoutId = null;
let telegramJobTimeoutId = null;

// --- HTTP Server (No changes needed) ---
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') {
        console.log(`[HTTP ${new Date().toISOString()}] Received /ping`);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('pong');
    } else if (req.method === 'GET' && req.url === '/health') {
        console.log(`[HTTP ${new Date().toISOString()}] Received /health`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            contentJobRunning: isContentJobRunning,
            telegramJobRunning: isTelegramJobRunning,
            nextContentRunScheduled: contentJobTimeoutId !== null,
            nextTelegramRunScheduled: telegramJobTimeoutId !== null
        }));
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
});
server.listen(config.port, () => { console.log(`[HTTP Server] Listening on port ${config.port}`); });
server.on('error', (error) => { console.error('[HTTP Server] Server Error:', error); });
// --- End HTTP Server ---

// --- Content Generation Job Cycle ---
async function runContentJobCycle() {
    if (isContentJobRunning) {
        console.log(`[ContentJob ${new Date().toISOString()}] Cycle already running. Skipping.`);
        scheduleNextContentRun(); // Ensure next run is still scheduled
        return;
    }
    isContentJobRunning = true;
    console.log(`\n============ [ContentJob ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        console.log(" -> Fetching Pro users for content generation...");
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for content:", error.message);
        } else if (!users || users.length === 0) {
            console.log(" -> No Pro users found for content generation.");
        } else {
            console.log(` -> Found ${users.length} Pro users for content. Checking eligibility...`);
            for (const user of users) {
                try { await processUser(user); }
                catch (userError) { console.error(`!!! [ContentJob ${new Date().toISOString()}] Uncaught error processing content for ${user.user_email}:`, userError.message); }
            }
            console.log(` -> Finished content processing loop for ${users.length} Pro users.`);
        }
    } catch (cycleError) {
        console.error(`!!! [ContentJob ${new Date().toISOString()}] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        console.log(`============ [ContentJob ${new Date().toISOString()}] Cycle Ended ============`);
        isContentJobRunning = false;
        scheduleNextContentRun();
    }
}

function scheduleNextContentRun() {
    if (contentJobTimeoutId) clearTimeout(contentJobTimeoutId);
    console.log(`[Scheduler] Scheduling next Content Job cycle in ${config.jobIntervalMs / 1000} seconds...`);
    contentJobTimeoutId = setTimeout(runContentJobCycle, config.jobIntervalMs);
}

// --- Telegram Sending Job Cycle ---
async function runTelegramJobCycle() {
     if (isTelegramJobRunning) {
         console.log(`[TelegramJob ${new Date().toISOString()}] Cycle already running. Skipping.`);
         scheduleNextTelegramRun(); // Ensure next run is still scheduled
         return;
     }
     isTelegramJobRunning = true;
     console.log(`\n============ [TelegramJob ${new Date().toISOString()}] Starting Cycle ============`);

     try {
         console.log(" -> Fetching Pro users with Telegram IDs...");
         const { data: users, error } = await supabase
             .from('user_preferences')
             .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro') // Select needed fields
             .eq('ispro', true)
             .not('telegramid', 'is', null); // Only fetch users with a telegramid

         if (error) {
             console.error(" -> Error fetching users for Telegram:", error.message);
         } else if (!users || users.length === 0) {
             console.log(" -> No eligible Pro users with Telegram IDs found.");
         } else {
             console.log(` -> Found ${users.length} Pro users with Telegram IDs. Checking eligibility...`);
             // Process users sequentially for Telegram sending to avoid potential rate limits
             for (const user of users) {
                 try { await processTelegramUser(user); }
                 catch (userError) { console.error(`!!! [TelegramJob ${new Date().toISOString()}] Uncaught error processing Telegram for ${user.user_email}:`, userError.message); }
             }
             console.log(` -> Finished Telegram processing loop for ${users.length} users.`);
         }
     } catch (cycleError) {
         console.error(`!!! [TelegramJob ${new Date().toISOString()}] Critical error during cycle:`, cycleError.message, cycleError.stack);
     } finally {
         console.log(`============ [TelegramJob ${new Date().toISOString()}] Cycle Ended ============`);
         isTelegramJobRunning = false;
         scheduleNextTelegramRun();
     }
 }

 function scheduleNextTelegramRun() {
     if (telegramJobTimeoutId) clearTimeout(telegramJobTimeoutId);
     console.log(`[Scheduler] Scheduling next Telegram Job cycle in ${config.telegramJobIntervalMs / 1000} seconds...`);
     telegramJobTimeoutId = setTimeout(runTelegramJobCycle, config.telegramJobIntervalMs);
 }


// --- Initial Start ---
console.log("Starting DegenTimes Worker Process...");
console.log(` - Content Job Interval: ${config.jobIntervalMs / 1000}s`);
console.log(` - Telegram Job Interval: ${config.telegramJobIntervalMs / 1000}s`);
console.log(` - OpenServ Wait Time: ${config.openservWaitMs / 1000}s`);
console.log(` - Content Refresh Time: ${config.jobRefreshHours} hours`);
console.log(` - Telegram Send Interval: ${config.telegramSendIntervalHours} hours`);

// Start both job cycles
runContentJobCycle();
runTelegramJobCycle();

// Handle graceful shutdown
function shutdown(signal) {
    console.log(`[Process] ${signal} signal received. Shutting down gracefully.`);
    server.close(() => { console.log('[HTTP Server] Closed.'); });
    if (contentJobTimeoutId) { clearTimeout(contentJobTimeoutId); console.log('[Scheduler] Cleared Content Job schedule.') }
    if (telegramJobTimeoutId) { clearTimeout(telegramJobTimeoutId); console.log('[Scheduler] Cleared Telegram Job schedule.') }
    // Give a brief moment for logs to flush
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT')); // Handle Ctrl+C
