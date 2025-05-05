// ================================================
// FILE: processUser.js
// ================================================
import { supabase } from './supabaseClient.js';
import { postMessage, getMessages, getLastAgentMessage, wait } from './openservClient.js';
import config from './config.js';

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

// --- ADD 'export' HERE ---
export function needsScheduledUpdate(user) {
    if (!user || !user.ispro) return false;

    const now = new Date();
    const jobRefreshThreshold = new Date(now.getTime() - config.jobRefreshHours * 60 * 60 * 1000);

    if (user.last_job) {
        const lastJobTime = new Date(user.last_job);
        if (lastJobTime < jobRefreshThreshold) {
            return true; // Needs update if last job is too old
        }

        // Also check if preferences updated *after* the last job
        if (user.preference_update) {
            const prefUpdateTime = new Date(user.preference_update);
            if (prefUpdateTime > lastJobTime) {
                 // console.log(` -> [${user.user_email}] Needs scheduled update (preference changed after last job).`);
                 return true; // Needs update if preferences changed recently
            }
        }
        // console.log(` -> [${user.user_email}] Does not need scheduled update.`);
        return false; // Otherwise, up-to-date based on schedule
    } else {
        // console.log(` -> [${user.user_email}] Needs scheduled update (no last job time).`);
        return true; // Needs update if never run before
    }
}

// --- ADD 'export' HERE ---
export function needsImmediateUpdate(user) {
     if (!user || !user.ispro) return false;

     // If never run, it needs an immediate update to populate initially
     if (!user.last_job) {
          // console.log(` -> [${user.user_email}] Needs immediate update (no last job).`);
          return true;
     }

     // If preferences changed since the last run, update immediately
     if (user.preference_update) {
          const prefUpdateTime = new Date(user.preference_update);
          const lastJobTime = new Date(user.last_job);
          if (prefUpdateTime > lastJobTime) {
               // console.log(` -> [${user.user_email}] Needs immediate update (preference changed).`);
               return true;
          }
     }

     // If any core content field is missing or has the placeholder, update immediately
     const needsFilling = !user.watchlist || user.watchlist === PLACEHOLDER_MESSAGE ||
                         !user.sector || user.sector === PLACEHOLDER_MESSAGE ||
                         !user.narrative || user.narrative === PLACEHOLDER_MESSAGE;
     if (needsFilling) {
         // console.log(` -> [${user.user_email}] Needs immediate update (placeholder found).`);
         return true;
     }

     // console.log(` -> [${user.user_email}] Does not need immediate update.`);
     return false; // Doesn't meet immediate criteria
}

// This one was already exported correctly
export const processUser = async (user, forceRun = false) => {
    const runReason = forceRun ? "Forced Run"
                     : needsImmediateUpdate(user) ? "Immediate Update" // Now uses the exported function correctly
                     : needsScheduledUpdate(user) ? "Scheduled Update" // Now uses the exported function correctly
                     : null;

    // ... (rest of the processUser function remains the same) ...
     if (!runReason) {
        // console.log(` -> [${user.user_email}] Skipping processing (no update needed).`);
        return false; // Indicate nothing was run
    }
    console.log(`\n--- Processing User: ${user.user_email} (Reason: ${runReason}) ---`);

    let preferences;
    try {
        preferences = user.preferences; // Assuming user object passed in already has preferences parsed if needed
        if (!preferences || typeof preferences !== 'object') {
            // If preferences might be a JSON string:
            // try { preferences = JSON.parse(user.preferences); } catch { throw new Error("Invalid JSON in preferences."); }
            // If preferences should always be an object:
             throw new Error("Invalid or missing preferences object.");
        }
    } catch (e) {
        console.error(` -> [${user.user_email}] Error parsing preferences: ${e.message}.`);
        // Potentially update DB to indicate error state?
        return false; // Indicate failure
    }


    // Use empty arrays as defaults if properties don't exist
    const { watchlistItems = [], selectedSectors = [], selectedNarratives = [] } = preferences;
    const updates = {}; // Object to hold columns to update in Supabase

    // Define categories and check if they have items to process
    const categoriesToProcess = [
        { name: 'Watchlist', items: watchlistItems, workspaceId: config.openservWorkspaceIdWatchlist, updateKey: 'watchlist', needsApiCall: watchlistItems.length > 0 },
        { name: 'Sector', items: selectedSectors, workspaceId: config.openservWorkspaceIdSector, updateKey: 'sector', needsApiCall: selectedSectors.length > 0 },
        { name: 'Narrative', items: selectedNarratives, workspaceId: config.openservWorkspaceIdNarrative, updateKey: 'narrative', needsApiCall: selectedNarratives.length > 0 }
    ];

    const postPromises = [];
    const categoryInfoForGet = []; // Keep track of which category corresponds to which promise

    // Initiate POST requests for categories that need processing
    categoriesToProcess.forEach((cat) => {
        if (cat.needsApiCall) {
            const prompt = `Give me news Titled ${cat.name} News : This will only contain news that happened today on the following crypto topics/items {${cat.items.join(', ')}} with each news section having a why it matters part`;
             console.log(`   - Queuing POST for ${cat.name}`);
            postPromises.push(postMessage(cat.workspaceId, config.openservAgentId, prompt));
            categoryInfoForGet.push({ ...cat }); // Store info needed later
        } else {
             // If no items, set the placeholder message directly
             console.log(`   - Setting placeholder for ${cat.name} (no items)`);
            updates[cat.updateKey] = PLACEHOLDER_MESSAGE;
        }
    });

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
                // Don't need to do anything here, just succeeded
            } else {
                // If POST failed, log error and set error message for update
                console.error(`    - POST for ${catInfo.name} failed: ${result.reason?.message || result.reason}`);
                updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news generation.`;
                processingSucceeded = false; // Mark as failed if POST fails
            }
        });

        // Only proceed to GET if at least one POST was successful
        if (postResults.some(r => r.status === 'fulfilled')) {
            console.log(` -> Waiting ${config.openservWaitMs / 1000}s for OpenServ to process...`);
            await wait(config.openservWaitMs);

            const getPromises = [];
            const categoryInfoForUpdate = []; // Track info for successful POSTs

            // Initiate GET requests only for categories where POST succeeded
            postResults.forEach((postResult, index) => {
                const catInfo = categoryInfoForGet[index];
                if (postResult.status === 'fulfilled') {
                     console.log(`   - Queuing GET for ${catInfo.name}`);
                    getPromises.push(getMessages(catInfo.workspaceId, config.openservAgentId));
                    categoryInfoForUpdate.push(catInfo); // Store info for update step
                }
            });

            // If there were GET requests to make
            if (getPromises.length > 0) {
                 console.log(` -> Waiting for ${getPromises.length} GET requests to settle...`);
                const getResults = await Promise.allSettled(getPromises);

                 // Process results of GET requests
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
                             // Decide what to put here - null, placeholder, or specific error?
                             // Setting to null might be clearer than placeholder if generation just failed.
                             updates[catInfo.updateKey] = null; // Or maybe: "Agent did not provide a response."
                         }
                     } else {
                         // If GET failed, log error and set error message for update
                         console.error(`    - GET for ${catInfo.name} failed: ${getResult.reason?.message || getResult.reason}`);
                         updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news result.`;
                         processingSucceeded = false; // Mark as failed if GET fails
                     }
                 });
            }
        } else {
             // If no POSTs were successful, mark the overall process as failed
             console.warn(` -> Skipping GET requests as all POSTs failed.`);
             processingSucceeded = false; // Mark as failed if no POSTs were successful
        }

    } else {
        console.log(` -> No API calls needed for this user.`);
        // If no API calls were even attempted, we consider it "successful" in terms of API interaction
        // (though it just set placeholders). The function should return true unless DB update fails.
    }

    // Always update the last_job timestamp
    updates.last_job = new Date().toISOString();
    // Optionally clear preference_update if you want to signify it's been processed
    // updates.preference_update = null;

    // Update Supabase with results (or placeholders/errors)
    try {
        console.log(` -> Updating Supabase for ${user.user_email} with keys: ${Object.keys(updates).join(', ')}`);
        const { error: updateError } = await supabase
            .from('user_preferences')
            .update(updates)
            .eq('user_email', user.user_email);

        if (updateError) {
            throw updateError; // Throw to be caught below
        }
        console.log(` -> [${user.user_email}] Supabase update successful.`);
        return processingSucceeded; // Return true if all API steps that were attempted succeeded
    } catch (error) {
        console.error(` -> [${user.user_email}] Error updating Supabase:`, error.message);
        return false; // Indicate failure
    }
};
