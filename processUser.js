// ================================================
// FILE: processUser.js
// ================================================
import { supabase } from './supabaseClient.js';
import { postMessage, getMessages, getLastAgentMessage, wait } from './openservClient.js';
import config from './config.js'; // Assuming config is needed later

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

// ... (keep the needsScheduledUpdate and needsImmediateUpdate functions as they are) ...

export const processUser = async (user, forceRun = false) => {
    const runReason = forceRun ? "Forced Run"
                     : needsImmediateUpdate(user) ? "Immediate Update"
                     : needsScheduledUpdate(user) ? "Scheduled Update"
                     : null;

    if (!runReason) {
        return false;
    }
    console.log(`\n--- Processing User: ${user.user_email} (Reason: ${runReason}) ---`);

    // --- MODIFIED PREFERENCES HANDLING ---
    let preferences = user.preferences; // Get the value from the fetched user object

    if (preferences === null || typeof preferences === 'undefined') {
        // If preferences field is explicitly null or doesn't exist
        console.warn(` -> [${user.user_email}] Preferences field is null or undefined. Treating as empty.`);
        preferences = {}; // Default to an empty object
    } else if (typeof preferences !== 'object') {
        // If it exists but isn't an object (e.g., string, number)
        // This might indicate a data type issue in Supabase (e.g., TEXT instead of JSONB)
        console.error(` -> [${user.user_email}] Preferences field is not an object (type: ${typeof preferences}). Check DB schema/data. Treating as empty.`);
        // Optionally log the actual value for debugging, careful with sensitive data:
        // console.error(`   Value received:`, preferences);
        preferences = {}; // Default to an empty object
        // You *could* decide to return false here if this indicates a critical data error:
        // return false;
    }
    // Now, 'preferences' is guaranteed to be an object, even if empty.
    // The original try/catch block around this specific part is no longer needed.

    // Destructuring will now safely default to empty arrays if the properties don't exist
    const { watchlistItems = [], selectedSectors = [], selectedNarratives = [] } = preferences;
    const updates = {}; // Object to hold columns to update in Supabase

    // Define categories and check if they have items to process
    const categoriesToProcess = [
        { name: 'Watchlist', items: watchlistItems, workspaceId: config.openservWorkspaceIdWatchlist, updateKey: 'watchlist', needsApiCall: watchlistItems.length > 0 },
        { name: 'Sector', items: selectedSectors, workspaceId: config.openservWorkspaceIdSector, updateKey: 'sector', needsApiCall: selectedSectors.length > 0 },
        { name: 'Narrative', items: selectedNarratives, workspaceId: config.openservWorkspaceIdNarrative, updateKey: 'narrative', needsApiCall: selectedNarratives.length > 0 }
    ];

    const postPromises = [];
    const categoryInfoForGet = [];

    // Initiate POST requests for categories that need processing
    categoriesToProcess.forEach((cat) => {
        if (cat.needsApiCall) {
            const prompt = `Give me news Titled ${cat.name} News : This will only contain news that happened today on the following crypto topics/items {${cat.items.join(', ')}} with each news section having a why it matters part`;
             console.log(`   - Queuing POST for ${cat.name}`); // Added log
            postPromises.push(postMessage(cat.workspaceId, config.openservAgentId, prompt));
            categoryInfoForGet.push({ ...cat });
        } else {
             // If no items, set the placeholder message directly
             console.log(`   - Setting placeholder for ${cat.name} (no items)`); // Added log
            updates[cat.updateKey] = PLACEHOLDER_MESSAGE;
        }
    });

    // ... (rest of the processUser function remains the same) ...
    // ... (handling postResults, getResults, and Supabase update) ...

    let postResults = [];
    let processingSucceeded = true; // Assume success unless an API call fails critically

    // If there were POST requests to make
    if (postPromises.length > 0) {
         console.log(` -> Waiting for ${postPromises.length} POST requests to settle...`);
        postResults = await Promise.allSettled(postPromises);

        // Process results of POST requests
        postResults.forEach((result, index) => {
            const catInfo = categoryInfoForGet[index];
            if (result.status === 'fulfilled') {
                 console.log(`    - POST for ${catInfo.name} succeeded.`);
            } else {
                console.error(`    - POST for ${catInfo.name} failed: ${result.reason?.message || result.reason}`);
                updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news generation.`;
                processingSucceeded = false;
            }
        });

        if (postResults.some(r => r.status === 'fulfilled')) {
            console.log(` -> Waiting ${config.openservWaitMs / 1000}s for OpenServ to process...`);
            await wait(config.openservWaitMs);

            const getPromises = [];
            const categoryInfoForUpdate = [];

            postResults.forEach((postResult, index) => {
                const catInfo = categoryInfoForGet[index];
                if (postResult.status === 'fulfilled') {
                     console.log(`   - Queuing GET for ${catInfo.name}`);
                    getPromises.push(getMessages(catInfo.workspaceId, config.openservAgentId));
                    categoryInfoForUpdate.push(catInfo);
                }
            });

            if (getPromises.length > 0) {
                 console.log(` -> Waiting for ${getPromises.length} GET requests to settle...`);
                const getResults = await Promise.allSettled(getPromises);

                 getResults.forEach((getResult, index) => {
                     const catInfo = categoryInfoForUpdate[index];
                     if (getResult.status === 'fulfilled') {
                         const messages = getResult.value;
                         const agentResponse = getLastAgentMessage(messages);
                         if (agentResponse) {
                              console.log(`    - GET for ${catInfo.name} successful. Found agent response.`);
                             updates[catInfo.updateKey] = agentResponse;
                         } else {
                              console.warn(`    - GET for ${catInfo.name} successful, but no agent response found.`);
                             updates[catInfo.updateKey] = null;
                         }
                     } else {
                         console.error(`    - GET for ${catInfo.name} failed: ${getResult.reason?.message || getResult.reason}`);
                         updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news result.`;
                         processingSucceeded = false;
                     }
                 });
            }
        } else {
             console.warn(` -> Skipping GET requests as all POSTs failed.`);
             processingSucceeded = false;
        }
    } else {
        console.log(` -> No API calls needed for this user.`);
    }

    updates.last_job = new Date().toISOString();

    try {
        console.log(` -> Updating Supabase for ${user.user_email} with keys: ${Object.keys(updates).join(', ')}`);
        const { error: updateError } = await supabase
            .from('user_preferences')
            .update(updates)
            .eq('user_email', user.user_email);

        if (updateError) {
            throw updateError;
        }
        console.log(` -> [${user.user_email}] Supabase update successful.`);
        return processingSucceeded;
    } catch (error) {
        console.error(` -> [${user.user_email}] Error updating Supabase:`, error.message);
        return false;
    }
};
