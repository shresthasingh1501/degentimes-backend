// processUser.js
import { supabase } from './supabaseClient.js';
import { postMessage, getMessages, getLastAgentMessage, wait } from './openservClient.js';
import config from './config.js';

/**
 * Checks if a job needs to run for a user based on conditions.
 * (No changes needed in this function)
 */
function shouldRunJob(user) {
    if (!user || !user.ispro) return false;
    const needsFilling = !user.watchlist || !user.sector || !user.narrative;
    if (needsFilling) {
        console.log(` -> [${user.user_email}] Job needed: Content field(s) are null or placeholder.`);
        return true;
    }
    const now = new Date();
    const jobRefreshThreshold = new Date(now.getTime() - config.jobRefreshHours * 60 * 60 * 1000);
    if (user.last_job) {
        const lastJobTime = new Date(user.last_job);
        if (lastJobTime < jobRefreshThreshold) {
            console.log(` -> [${user.user_email}] Job needed: Last run (${lastJobTime.toISOString()}) > ${config.jobRefreshHours} hours ago.`);
            return true;
        }
        if (user.preference_update) {
            const prefUpdateTime = new Date(user.preference_update);
            if (prefUpdateTime > lastJobTime) {
                 console.log(` -> [${user.user_email}] Job needed: Preferences updated (${prefUpdateTime.toISOString()}) after last job (${lastJobTime.toISOString()}).`);
                 return true;
            }
        }
    } else {
        console.log(` -> [${user.user_email}] Job needed: Content fields exist but last_job is null (running once).`);
        return true;
    }
    // console.log(` -> [${user.user_email}] Job not needed (conditions: initial fill, ${config.jobRefreshHours}hr refresh, pref update check).`);
    return false;
}

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";

/**
 * Processes a single user: checks eligibility, calls OpenServ APIs concurrently *only for categories with preferences*,
 * sets placeholders for empty preferences, updates Supabase.
 */
export const processUser = async (user) => {
    if (!shouldRunJob(user)) {
        return; // Exit if conditions not met
    }
    console.log(`\n--- Processing User: ${user.user_email} ---`);

    // --- 1. Extract Preferences ---
    let preferences;
    try {
        preferences = user.preferences;
        if (!preferences || typeof preferences !== 'object') {
            throw new Error("Invalid or missing preferences object.");
        }
    } catch (e) {
        console.error(` -> [${user.user_email}] Error parsing preferences: ${e.message}. Skipping content generation.`);
        return;
    }

    const { watchlistItems = [], selectedSectors = [], selectedNarratives = [] } = preferences;
    const updates = {}; // Store final results for Supabase

    // Define categories and check if they need API calls
    const categoriesToProcess = [
        { name: 'Watchlist', items: watchlistItems, workspaceId: config.openservWorkspaceIdWatchlist, updateKey: 'watchlist', needsApiCall: watchlistItems.length > 0 },
        { name: 'Sector', items: selectedSectors, workspaceId: config.openservWorkspaceIdSector, updateKey: 'sector', needsApiCall: selectedSectors.length > 0 },
        { name: 'Narrative', items: selectedNarratives, workspaceId: config.openservWorkspaceIdNarrative, updateKey: 'narrative', needsApiCall: selectedNarratives.length > 0 }
    ];

    // --- 2. Prepare & Execute Parallel POST Requests (only for eligible categories) ---
    console.log(` -> [${user.user_email}] Preparing API calls based on preferences...`);
    const postPromises = [];
    const categoryInfoForGet = []; // Store info needed for GET calls later

    categoriesToProcess.forEach((cat, index) => {
        if (cat.needsApiCall) {
            console.log(`    - Scheduling API call for ${cat.name}.`);
            const prompt = `Give me news Titled ${cat.name} News : This will only contain news that happened today on the following crypto topics/items {${cat.items.join(', ')}} with each news section having a why it matters part`;
            postPromises.push(postMessage(cat.workspaceId, config.openservAgentId, prompt));
            categoryInfoForGet.push({ ...cat, originalIndex: index }); // Store details
        } else {
            console.log(`    - Setting placeholder for ${cat.name} (no preferences).`);
            updates[cat.updateKey] = PLACEHOLDER_MESSAGE; // Set placeholder directly
            // Add a resolved promise to keep array lengths consistent if needed, or handle indices carefully
            // postPromises.push(Promise.resolve({ status: 'skipped_no_pref' })); // Placeholder if needed for indexing
        }
    });

    // Only proceed with API calls if there's anything to call
    let postResults = [];
    if (postPromises.length > 0) {
        console.log(` -> [${user.user_email}] Sending ${postPromises.length} POST requests in parallel...`);
        postResults = await Promise.allSettled(postPromises);

        // Log POST results (correlating back using categoryInfoForGet)
        postResults.forEach((result, index) => {
            const catInfo = categoryInfoForGet[index]; // Info for the *called* API
            if (result.status === 'fulfilled') {
                console.log(`    - POST for ${catInfo.name} successful.`);
            } else {
                console.error(`    - POST for ${catInfo.name} failed: ${result.reason?.message || result.reason}`);
                // Set error message immediately if POST fails
                updates[catInfo.updateKey] = `Error initiating ${catInfo.name.toLowerCase()} news fetch. Please try again later.`;
            }
        });

        // --- 3. Wait Period ---
        console.log(` -> [${user.user_email}] Waiting ${config.openservWaitMs / 1000}s for agents to process...`);
        await wait(config.openservWaitMs);

        // --- 4. Prepare & Execute Parallel GET Requests (only for successful POSTs) ---
        console.log(` -> [${user.user_email}] Sending GET requests in parallel...`);
        const getPromises = [];
        const categoryInfoForUpdate = []; // Track which updates correspond to GET results

        postResults.forEach((postResult, index) => {
            const catInfo = categoryInfoForGet[index];
            // Only attempt GET if the POST was fulfilled
            if (postResult.status === 'fulfilled') {
                console.log(`    - Scheduling GET for ${catInfo.name}...`);
                getPromises.push(getMessages(catInfo.workspaceId, config.openservAgentId));
                categoryInfoForUpdate.push(catInfo); // Track this category for update
            } else {
                // POST failed, error message already set in 'updates' object
                console.log(`    - Skipping GET for ${catInfo.name} (POST failed).`);
            }
        });

        if (getPromises.length > 0) {
            const getResults = await Promise.allSettled(getPromises);

             // --- 5. Collate GET Results ---
             getResults.forEach((getResult, index) => {
                 const catInfo = categoryInfoForUpdate[index]; // Info for the *called* GET
                 if (getResult.status === 'fulfilled') {
                     const messages = getResult.value; // Array of messages
                     const agentResponse = getLastAgentMessage(messages);
                     if (agentResponse) {
                         console.log(`    - GET for ${catInfo.name} successful, response found.`);
                         updates[catInfo.updateKey] = agentResponse; // Assign message
                     } else {
                         console.warn(`    - GET for ${catInfo.name} successful, but no agent response found.`);
                         updates[catInfo.updateKey] = null; // Set to null if no response found
                     }
                 } else {
                     // GET promise was rejected
                     console.error(`    - GET for ${catInfo.name} failed: ${getResult.reason?.message || getResult.reason}`);
                     updates[catInfo.updateKey] = `Error fetching ${catInfo.name.toLowerCase()} news result. Please try again later.`;
                 }
             });
        } else {
             console.log(` -> [${user.user_email}] No successful POSTs, skipping all GET requests.`);
        }

    } else {
        console.log(` -> [${user.user_email}] No API calls needed based on preferences.`);
    }


    // --- 6. Update Supabase ---
    updates.last_job = new Date().toISOString(); // Always update last_job timestamp

    // Log the final updates being sent (excluding potentially large content)
    const updateSummary = Object.keys(updates)
        .filter(k => k !== 'watchlist' && k !== 'sector' && k !== 'narrative')
        .reduce((acc, key) => { acc[key] = updates[key]; return acc; }, {});
    updateSummary.content_keys = Object.keys(updates).filter(k => ['watchlist', 'sector', 'narrative'].includes(k));
    console.log(` -> [${user.user_email}] Preparing Supabase update with keys: ${Object.keys(updates).join(', ')}`);


    try {
        const { error: updateError } = await supabase
            .from('user_preferences')
            .update(updates)
            .eq('user_email', user.user_email);

        if (updateError) {
            throw updateError;
        }
        console.log(` -> [${user.user_email}] Supabase update successful.`);
    } catch (error) {
        console.error(` -> [${user.user_email}] Error updating Supabase:`, error.message);
    }

    console.log(`--- Finished Processing User: ${user.user_email} ---`);
};
