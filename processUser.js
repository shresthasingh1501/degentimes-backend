// ================================================
// FILE: processUser.js
// ================================================
import { supabase } from './supabaseClient.js';
import { postMessage, getMessages, getLastAgentMessage, wait } from './openservClient.js';
import config from './config.js';

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

function needsScheduledUpdate(user) {
    if (!user || !user.ispro) return false;

    const now = new Date();
    const jobRefreshThreshold = new Date(now.getTime() - config.jobRefreshHours * 60 * 60 * 1000);

    if (user.last_job) {
        const lastJobTime = new Date(user.last_job);
        if (lastJobTime < jobRefreshThreshold) {
            return true;
        }

        if (user.preference_update) {
            const prefUpdateTime = new Date(user.preference_update);
            if (prefUpdateTime > lastJobTime) {
                 return true;
            }
        }
        return false;
    } else {
        return true;
    }
}

function needsImmediateUpdate(user) {
     if (!user || !user.ispro) return false;

     if (!user.last_job) {
          return true;
     }

     if (user.preference_update) {
          const prefUpdateTime = new Date(user.preference_update);
          const lastJobTime = new Date(user.last_job);
          if (prefUpdateTime > lastJobTime) {
               return true;
          }
     }

     const needsFilling = !user.watchlist || user.watchlist === PLACEHOLDER_MESSAGE ||
                         !user.sector || user.sector === PLACEHOLDER_MESSAGE ||
                         !user.narrative || user.narrative === PLACEHOLDER_MESSAGE;
     if (needsFilling) {
         return true;
     }

     return false;
}

export const processUser = async (user, forceRun = false) => {
    const runReason = forceRun ? "Forced Run"
                     : needsImmediateUpdate(user) ? "Immediate Update"
                     : needsScheduledUpdate(user) ? "Scheduled Update"
                     : null;

    if (!runReason) {
        return false;
    }
    // console.log(`\n--- Processing User: ${user.user_email} (Reason: ${runReason}) ---`);

    let preferences;
    try {
        preferences = user.preferences;
        if (!preferences || typeof preferences !== 'object') {
            throw new Error("Invalid or missing preferences object.");
        }
    } catch (e) {
        console.error(` -> [${user.user_email}] Error parsing preferences: ${e.message}.`);
        return false;
    }

    const { watchlistItems = [], selectedSectors = [], selectedNarratives = [] } = preferences;
    const updates = {};

    const categoriesToProcess = [
        { name: 'Watchlist', items: watchlistItems, workspaceId: config.openservWorkspaceIdWatchlist, updateKey: 'watchlist', needsApiCall: watchlistItems.length > 0 },
        { name: 'Sector', items: selectedSectors, workspaceId: config.openservWorkspaceIdSector, updateKey: 'sector', needsApiCall: selectedSectors.length > 0 },
        { name: 'Narrative', items: selectedNarratives, workspaceId: config.openservWorkspaceIdNarrative, updateKey: 'narrative', needsApiCall: selectedNarratives.length > 0 }
    ];

    const postPromises = [];
    const categoryInfoForGet = [];

    categoriesToProcess.forEach((cat) => {
        if (cat.needsApiCall) {
            const prompt = `Give me news Titled ${cat.name} News : This will only contain news that happened today on the following crypto topics/items {${cat.items.join(', ')}} with each news section having a why it matters part`;
            postPromises.push(postMessage(cat.workspaceId, config.openservAgentId, prompt));
            categoryInfoForGet.push({ ...cat });
        } else {
            updates[cat.updateKey] = PLACEHOLDER_MESSAGE;
        }
    });

    let postResults = [];
    let processingSucceeded = true; // Assume success unless an API call fails critically

    if (postPromises.length > 0) {
        postResults = await Promise.allSettled(postPromises);

        postResults.forEach((result, index) => {
            const catInfo = categoryInfoForGet[index];
            if (result.status === 'fulfilled') {
            } else {
                console.error(`    - POST for ${catInfo.name} failed: ${result.reason?.message || result.reason}`);
                updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news generation.`;
                processingSucceeded = false; // Mark as failed if POST fails
            }
        });

        if (postResults.some(r => r.status === 'fulfilled')) {
            await wait(config.openservWaitMs);

            const getPromises = [];
            const categoryInfoForUpdate = [];

            postResults.forEach((postResult, index) => {
                const catInfo = categoryInfoForGet[index];
                if (postResult.status === 'fulfilled') {
                    getPromises.push(getMessages(catInfo.workspaceId, config.openservAgentId));
                    categoryInfoForUpdate.push(catInfo);
                }
            });

            if (getPromises.length > 0) {
                const getResults = await Promise.allSettled(getPromises);

                 getResults.forEach((getResult, index) => {
                     const catInfo = categoryInfoForUpdate[index];
                     if (getResult.status === 'fulfilled') {
                         const messages = getResult.value;
                         const agentResponse = getLastAgentMessage(messages);
                         if (agentResponse) {
                             updates[catInfo.updateKey] = agentResponse;
                         } else {
                             updates[catInfo.updateKey] = null;
                         }
                     } else {
                         console.error(`    - GET for ${catInfo.name} failed: ${getResult.reason?.message || getResult.reason}`);
                         updates[catInfo.updateKey] = `${ERROR_FETCHING_PREFIX} ${catInfo.name.toLowerCase()} news result.`;
                         processingSucceeded = false; // Mark as failed if GET fails
                     }
                 });
            }
        } else {
             processingSucceeded = false; // Mark as failed if no POSTs were successful
        }

    }

    updates.last_job = new Date().toISOString();

    try {
        const { error: updateError } = await supabase
            .from('user_preferences')
            .update(updates)
            .eq('user_email', user.user_email);

        if (updateError) {
            throw updateError;
        }
        // console.log(` -> [${user.user_email}] Supabase update successful.`);
        return processingSucceeded; // Return true if all API steps that were attempted succeeded
    } catch (error) {
        console.error(` -> [${user.user_email}] Error updating Supabase:`, error.message);
        return false; // Indicate failure
    }
};
