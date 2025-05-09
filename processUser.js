import { supabase } from './supabaseClient.js';
import {
    postMessage,
    getMessages,
    getLastAgentMessage,
    wait,
    postMessageToTwitterAgent,
    getMessagesFromTwitterAgent
} from './openservClient.js';
import { getActionableInsights } from './geminiClient.js';
import config from './config.js';

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = config.errorFetchingPrefix;
const SOCIAL_ERROR_MESSAGE = config.socialErrorMessagePrefix + " for this item.";
const SOCIAL_PLACEHOLDER_MESSAGE = config.socialPlaceholderPrefix + ".";
const GEMINI_ERROR_MESSAGE = "Error generating AI insights. Please check back later.";
const GEMINI_PLACEHOLDER_NO_DATA = "AI insights require underlying news or social data. Please set preferences or wait for data to populate.";

const getYesterdayDateString = () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0');
    const day = String(yesterday.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

async function executePromisesWithConcurrency(promiseFactories, concurrencyLimit) {
    const results = [];
    const executing = new Set();
    let index = 0;

    async function runNext() {
        if (index >= promiseFactories.length && executing.size === 0) { return; }
        while (executing.size < concurrencyLimit && index < promiseFactories.length) {
            const currentFactory = promiseFactories[index];
            const promiseIndex = index; index++;
            const promise = currentFactory()
                .then(result => ({ index: promiseIndex, status: 'fulfilled', value: result }))
                .catch(error => ({ index: promiseIndex, status: 'rejected', reason: error }));
            executing.add(promise);
            results[promiseIndex] = undefined;
            promise.then((outcome) => {
                executing.delete(promise);
                results[outcome.index] = outcome; runNext();
            });
        }
    }
    const initialBatchSize = Math.min(concurrencyLimit, promiseFactories.length);
    for (let i = 0; i < initialBatchSize; i++) { await runNext(); }
    return new Promise(resolve => {
        const checkCompletion = () => {
            if (results.length === promiseFactories.length && results.every(r => r !== undefined) && executing.size === 0) { resolve(results); }
            else { setTimeout(checkCompletion, 150); }
        };
        checkCompletion();
    });
}
const OPENSERV_CONCURRENCY_LIMIT = 6;

export function needsScheduledUpdate(user) {
    if (!user || !user.ispro) return false;
    const now = new Date();
    const jobRefreshThreshold = new Date(now.getTime() - config.jobRefreshHours * 60 * 60 * 1000);
    if (user.last_job) {
        const lastJobTime = new Date(user.last_job);
        if (lastJobTime < jobRefreshThreshold) return true;
        if (user.preference_update) {
            if (new Date(user.preference_update) > lastJobTime) return true;
        }
        if (config.geminiApiKey) {
            if (!user.ai_last_update) return true;
            if (new Date(user.ai_last_update) < jobRefreshThreshold) return true;
            if (lastJobTime > new Date(user.ai_last_update)) return true;
        }
        return false;
    }
    return true;
}

export function needsImmediateUpdate(user) {
    if (!user || !user.ispro) return false;
    if (!user.last_job) return true;

    if (user.preference_update) {
        if (new Date(user.preference_update) > new Date(user.last_job)) return true;
    }

    const finalOutputIsPlaceholderOrError = (field) => !field || field === PLACEHOLDER_MESSAGE || field === GEMINI_ERROR_MESSAGE || field === GEMINI_PLACEHOLDER_NO_DATA || field.startsWith("Error:");
    const needsRefreshDueToFinalOutput =
        finalOutputIsPlaceholderOrError(user.watchlist) ||
        finalOutputIsPlaceholderOrError(user.sector) ||
        finalOutputIsPlaceholderOrError(user.narrative);

    const intelFieldIsPlaceholderOrError = (field) => !field || field.startsWith(config.placeholderMessagePrefix) || field.startsWith(ERROR_FETCHING_PREFIX);
    const intelFieldsAreEmptyOrError =
        intelFieldIsPlaceholderOrError(user.watchlist_intel) ||
        intelFieldIsPlaceholderOrError(user.sector_intel) ||
        intelFieldIsPlaceholderOrError(user.narrative_intel);

    if (needsRefreshDueToFinalOutput || intelFieldsAreEmptyOrError) return true;

    const socialFieldIsPlaceholderOrError = (field) => !field || field.startsWith(config.socialPlaceholderPrefix) || field.startsWith(ERROR_FETCHING_PREFIX) || field.startsWith(config.socialErrorMessagePrefix);
    if (config.openservTwitterApiKey) {
        if (socialFieldIsPlaceholderOrError(user.watchlist_social) ||
            socialFieldIsPlaceholderOrError(user.sector_social) ||
            socialFieldIsPlaceholderOrError(user.narrative_social)) {
            return true;
        }
    }

    if (config.geminiApiKey) {
        if (!user.ai_last_update) return true;
        if (user.last_job && user.ai_last_update && new Date(user.last_job) > new Date(user.ai_last_update)) return true;
        const finalOutputIsBadButIntelGood = (finalField, intelField) =>
            finalOutputIsPlaceholderOrError(finalField) && intelField && !intelFieldIsPlaceholderOrError(intelField);
        if (finalOutputIsBadButIntelGood(user.watchlist, user.watchlist_intel) ||
            finalOutputIsBadButIntelGood(user.sector, user.sector_intel) ||
            finalOutputIsBadButIntelGood(user.narrative, user.narrative_intel)) {
            return true;
        }
    }

    // REMOVED: Check for !user.tele_last_sent - this was causing repeats
    // The logic inside processUser handles the first send correctly.

    return false;
}

const createIntelTask = (itemName, categoryName, workspaceId) => {
    return async () => {
        const prompt = `Give me only WEB 3/CRYPTO news Titled ${itemName} News : This will only contain news that happened today on the topic {${itemName}} with each news section having a why it matters part`;
        try {
            await postMessage(workspaceId, config.openservAgentId, prompt);
            await wait(config.openservWaitMs);
            const messages = await getMessages(workspaceId, config.openservAgentId);
            const agentResponse = getLastAgentMessage(messages);
            return { item: itemName, category: categoryName, content: agentResponse || `${ERROR_FETCHING_PREFIX} content for ${itemName}.` };
        } catch (error) {
            console.error(`     - Error in Intel Task for '${itemName}' (${categoryName}): ${error.message}`);
            return Promise.reject({ item: itemName, category: categoryName, reason: error });
        }
    };
};

const createSocialTask = (itemName, categoryName, type, workspaceId, prompt) => {
    return async () => {
        try {
            await postMessageToTwitterAgent(workspaceId, config.openservTwitterAgentId, prompt);
            await wait(config.openservWaitMs);
            const messages = await getMessagesFromTwitterAgent(workspaceId, config.openservTwitterAgentId);
            const agentResponse = getLastAgentMessage(messages);
            return { item: itemName, category: categoryName, type, content: agentResponse || `No ${type.toLowerCase()} tweets found for ${itemName}.` };
        } catch (error) {
            console.error(`     - Error in Social Task (${type}) for '${itemName}' (${categoryName}): ${error.message}`);
            return Promise.reject({ item: itemName, category: categoryName, type, reason: error });
        }
    };
};

export const processUser = async (user, isForcedRun = false, determinedRunReason = null) => {
    const runReason = isForcedRun ? "Forced Run" : determinedRunReason;
    if (!runReason) {
        return false;
    }

    console.log(`\n--- Processing User: ${user.user_email} (Reason: ${runReason}) ---`);
    let preferences = user.preferences;
    if (preferences === null || typeof preferences !== 'object') preferences = {};

    const { watchlistItems = [], selectedSectors = [], selectedNarratives = [] } = preferences;
    const updates = {};
    let openServIntelProcessingAttempted = false;
    let openServSocialProcessingAttempted = false;
    let geminiProcessingAttempted = false;
    let anyGeminiCallSucceededThisRun = false;
    let anyTelegramPostSucceededThisRun = false;

    const aggregatedIntelData = { watchlist: [], sector: [], narrative: [] };
    const aggregatedSocialData = { watchlist: [], sector: [], narrative: [] };

    console.log(` -> [${user.user_email}] Intel Content Processing (per item)...`);
    let intelTasks = [];
    if (watchlistItems.length > 0) openServIntelProcessingAttempted = true;
    watchlistItems.forEach(item => intelTasks.push(createIntelTask(item, 'watchlist', config.openservWorkspaceIdWatchlist)));
    if (selectedSectors.length > 0) openServIntelProcessingAttempted = true;
    selectedSectors.forEach(item => intelTasks.push(createIntelTask(item, 'sector', config.openservWorkspaceIdSector)));
    if (selectedNarratives.length > 0) openServIntelProcessingAttempted = true;
    selectedNarratives.forEach(item => intelTasks.push(createIntelTask(item, 'narrative', config.openservWorkspaceIdNarrative)));

    if (intelTasks.length > 0) {
        console.log(`   -> Executing ${intelTasks.length} intel tasks with concurrency ${OPENSERV_CONCURRENCY_LIMIT}...`);
        const intelResults = await executePromisesWithConcurrency(intelTasks, OPENSERV_CONCURRENCY_LIMIT);
        console.log(`   -> Intel tasks finished. Processing ${intelResults.length} results.`);
        intelResults.forEach(result => {
            if (result.status === 'fulfilled') {
                aggregatedIntelData[result.value.category].push(`**${result.value.item}**:\n${result.value.content}`);
            } else {
                const { item, category = 'unknown', reason } = result.reason;
                console.error(`   - Failed Intel Task item: ${item}, category: ${category}, Reason: ${reason?.message || reason}`);
                aggregatedIntelData[category].push(`**${item || 'Unknown Item'}**:\nFailed to fetch intel. Reason: ${reason?.message || 'Unknown error'}`);
            }
        });
    }
    updates.watchlist_intel = aggregatedIntelData.watchlist.join('\n\n---\n\n') || (watchlistItems.length > 0 && openServIntelProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all watchlist intel.` : PLACEHOLDER_MESSAGE);
    updates.sector_intel = aggregatedIntelData.sector.join('\n\n---\n\n') || (selectedSectors.length > 0 && openServIntelProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all sector intel.` : PLACEHOLDER_MESSAGE);
    updates.narrative_intel = aggregatedIntelData.narrative.join('\n\n---\n\n') || (selectedNarratives.length > 0 && openServIntelProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all narrative intel.` : PLACEHOLDER_MESSAGE);
    console.log(` -> [${user.user_email}] Intel Content Processing Finished.`);


    if (config.openservTwitterApiKey && config.openservTwitterAgentId && config.openservTwitterConnectSid) {
        console.log(` -> [${user.user_email}] Social Content Processing (per item)...`);
        let socialTasks = [];
        const socialCategories = [
            { name: 'watchlist', items: watchlistItems, latestW: config.openservTwitterWorkspaceIdWatchlistLatest, topW: config.openservTwitterWorkspaceIdWatchlistTop },
            { name: 'sector', items: selectedSectors, latestW: config.openservTwitterWorkspaceIdSectorLatest, topW: config.openservTwitterWorkspaceIdSectorTop },
            { name: 'narrative', items: selectedNarratives, latestW: config.openservTwitterWorkspaceIdNarrativeLatest, topW: config.openservTwitterWorkspaceIdNarrativeTop },
        ];
        const sinceDateString = getYesterdayDateString();

        socialCategories.forEach(cat => {
            if (cat.items.length > 0 && cat.latestW && cat.topW) {
                openServSocialProcessingAttempted = true;
                cat.items.forEach(item => {
                    const latestPrompt = `Get me all the latest tweets on first page for topic ${item} since:${sinceDateString}`;
                    const topPrompt = `Get me all the top tweets on first page for topic ${item} since:${sinceDateString}`;
                    socialTasks.push(createSocialTask(item, cat.name, 'Latest', cat.latestW, latestPrompt));
                    socialTasks.push(createSocialTask(item, cat.name, 'Top', cat.topW, topPrompt));
                });
            }
        });

        if (socialTasks.length > 0) {
            console.log(`   -> Executing ${socialTasks.length} social tasks with concurrency ${OPENSERV_CONCURRENCY_LIMIT}...`);
            const socialResults = await executePromisesWithConcurrency(socialTasks, OPENSERV_CONCURRENCY_LIMIT);
            console.log(`   -> Social tasks finished. Processing ${socialResults.length} results.`);
            const tempSocialItemData = {};
            socialResults.forEach(result => {
                let item, category, type, content, reasonMsg;
                if (result.status === 'fulfilled') {
                    ({ item, category, type, content } = result.value);
                } else {
                    ({ item, category = 'unknown', type = 'unknown', reason: reasonMsg } = result.reason);
                     content = `${SOCIAL_ERROR_MESSAGE} (${type}) for ${item || 'Unknown Item'}. Details: ${reasonMsg?.message || 'Unknown error'}`;
                     console.error(`   - Failed Social Task item: ${item}, category: ${category}, type: ${type}, Reason: ${reasonMsg?.message || reasonMsg}`);
                }
                if (!tempSocialItemData[category]) tempSocialItemData[category] = {};
                if (!tempSocialItemData[category][item]) tempSocialItemData[category][item] = {};
                tempSocialItemData[category][item][type] = content;
            });
            for (const category in tempSocialItemData) {
                for (const item in tempSocialItemData[category]) {
                    const latest = tempSocialItemData[category][item]['Latest'] || "Not available.";
                    const top = tempSocialItemData[category][item]['Top'] || "Not available.";
                    aggregatedSocialData[category].push(`**${item}**:\nLATEST TWEETS (since ${sinceDateString}):\n${latest}\n\nTOP TWEETS (since ${sinceDateString}):\n${top}`);
                }
            }
        }
        updates.watchlist_social = aggregatedSocialData.watchlist.join('\n\n---\n\n') || (watchlistItems.length > 0 && openServSocialProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all watchlist social.` : SOCIAL_PLACEHOLDER_MESSAGE);
        updates.sector_social = aggregatedSocialData.sector.join('\n\n---\n\n') || (selectedSectors.length > 0 && openServSocialProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all sector social.` : SOCIAL_PLACEHOLDER_MESSAGE);
        updates.narrative_social = aggregatedSocialData.narrative.join('\n\n---\n\n') || (selectedNarratives.length > 0 && openServSocialProcessingAttempted ? `${ERROR_FETCHING_PREFIX} all narrative social.` : SOCIAL_PLACEHOLDER_MESSAGE);
        console.log(` -> [${user.user_email}] Social Content Processing Finished.`);

    } else {
        console.log(` -> [${user.user_email}] Skipping Social Content Processing (Twitter API not fully configured).`);
        ['watchlist_social', 'sector_social', 'narrative_social'].forEach((key) => {
            if (updates[key] === undefined) updates[key] = SOCIAL_PLACEHOLDER_MESSAGE;
        });
    }


    if (config.geminiApiKey) {
        console.log(` -> [${user.user_email}] Gemini AI Insights Processing...`);
        geminiProcessingAttempted = true;
        const finalInsightCategories = [
            { name: 'Watchlist', finalUpdateKey: 'watchlist', intelContent: updates.watchlist_intel, socialContent: updates.watchlist_social, items: watchlistItems },
            { name: 'Sector', finalUpdateKey: 'sector', intelContent: updates.sector_intel, socialContent: updates.sector_social, items: selectedSectors },
            { name: 'Narrative', finalUpdateKey: 'narrative', intelContent: updates.narrative_intel, socialContent: updates.narrative_social, items: selectedNarratives },
        ];

        for (const cat of finalInsightCategories) {
            const hasPreferenceItems = cat.items && cat.items.length > 0;
            const isIntelSubstantive = cat.intelContent && !cat.intelContent.startsWith(config.placeholderMessagePrefix) && !cat.intelContent.startsWith(ERROR_FETCHING_PREFIX);
            const isSocialSubstantive = config.openservTwitterApiKey && cat.socialContent && !cat.socialContent.startsWith(config.socialPlaceholderPrefix) && !cat.socialContent.startsWith(ERROR_FETCHING_PREFIX) && !cat.socialContent.startsWith(config.socialErrorMessagePrefix);

            let shouldCallGeminiForCategory = isForcedRun;
            if (!shouldCallGeminiForCategory) {
                const currentLastJobTimestamp = updates.last_job || user.last_job;
                const aiIsStaleOrMissing = !user.ai_last_update ||
                                       (currentLastJobTimestamp && user.ai_last_update && new Date(currentLastJobTimestamp) > new Date(user.ai_last_update)) ||
                                       (user.ai_last_update && new Date(user.ai_last_update) < new Date(Date.now() - config.jobRefreshHours * 3600000)) ||
                                       user[cat.finalUpdateKey] === GEMINI_ERROR_MESSAGE || user[cat.finalUpdateKey] === GEMINI_PLACEHOLDER_NO_DATA;
                if (hasPreferenceItems && (isIntelSubstantive || isSocialSubstantive) && aiIsStaleOrMissing) {
                    shouldCallGeminiForCategory = true;
                }
            }

            if (shouldCallGeminiForCategory) {
                 if (hasPreferenceItems && (isIntelSubstantive || isSocialSubstantive)) {
                    console.log(`   - Requesting Gemini insights for ${cat.name}`);
                    const geminiResponse = await getActionableInsights(cat.intelContent, cat.socialContent, cat.name);
                    if (geminiResponse && !geminiResponse.startsWith("Error:")) {
                        updates[cat.finalUpdateKey] = geminiResponse;
                        anyGeminiCallSucceededThisRun = true;
                    } else {
                        updates[cat.finalUpdateKey] = geminiResponse || GEMINI_ERROR_MESSAGE;
                    }
                 } else if (hasPreferenceItems) { updates[cat.finalUpdateKey] = GEMINI_PLACEHOLDER_NO_DATA; }
                 else { updates[cat.finalUpdateKey] = PLACEHOLDER_MESSAGE; }
            } else if (!hasPreferenceItems && updates[cat.finalUpdateKey] === undefined) {
                updates[cat.finalUpdateKey] = PLACEHOLDER_MESSAGE;
            }
        }
        console.log(` -> [${user.user_email}] Gemini AI Insights Processing Finished.`);
    } else {
        console.log(` -> [${user.user_email}] Skipping Gemini AI Insights (GEMINI_API_KEY not set). Final fields will use best available content.`);
        ['watchlist', 'sector', 'narrative'].forEach(catKey => {
            if (updates[catKey] === undefined) {
                const intelContent = updates[`${catKey}_intel`];
                const socialContent = updates[`${catKey}_social`];
                const intelIsGood = intelContent && !intelContent.startsWith(config.placeholderMessagePrefix) && !intelContent.startsWith(ERROR_FETCHING_PREFIX);
                const socialIsGood = config.openservTwitterApiKey && socialContent && !socialContent.startsWith(config.socialPlaceholderPrefix) && !socialContent.startsWith(ERROR_FETCHING_PREFIX) && !socialContent.startsWith(config.socialErrorMessagePrefix);

                if (intelIsGood && socialIsGood) {
                    updates[catKey] = `INTEL SUMMARY:\n${intelContent}\n\n---\n\nSOCIAL SUMMARY:\n${socialContent}`;
                } else if (intelIsGood) {
                    updates[catKey] = `INTEL SUMMARY:\n${intelContent}`;
                } else if (socialIsGood) {
                    updates[catKey] = `SOCIAL SUMMARY:\n${socialContent}`;
                } else {
                    updates[catKey] = PLACEHOLDER_MESSAGE;
                }
            }
        });
    }


    const telegramAgentId = config.openservTelegramAgentId;
    const telegramWorkspaceId = config.openservTelegramWorkspaceId;
    const canSendTelegram = telegramAgentId && telegramWorkspaceId && user.telegramid;

    if (canSendTelegram) {
        console.log(` -> [${user.user_email}] Telegram Sending Check...`);
        const now = Date.now();
        const sendThreshold = now - (config.telegramSendIntervalHours * 60 * 60 * 1000);
        const lastSentTime = user.tele_last_sent ? new Date(user.tele_last_sent).getTime() : 0;
        const isFirstSend = !user.tele_last_sent;

        let shouldSendTelegram = isForcedRun || isFirstSend || lastSentTime < sendThreshold;

        if (shouldSendTelegram) {
            console.log(`   - Conditions met (TG ID present, ${isFirstSend ? 'first send' : `time threshold passed (${config.telegramSendIntervalHours}h)`} or forced run). Checking content...`);
            const categoriesToSend = [
                { name: 'Watchlist', key: 'watchlist'},
                { name: 'Sector', key: 'sector'},
                { name: 'Narrative', key: 'narrative'}
            ];

            for (const cat of categoriesToSend) {
                const finalContent = updates[cat.key] !== undefined ? updates[cat.key] : user[cat.key];
                const isValidContent = finalContent &&
                                     finalContent !== PLACEHOLDER_MESSAGE &&
                                     finalContent !== GEMINI_ERROR_MESSAGE &&
                                     finalContent !== GEMINI_PLACEHOLDER_NO_DATA &&
                                     !finalContent.startsWith("Error:");

                if (isValidContent) {
                    const prompt = `Format this daily debrief {${finalContent}} properly as a Telegram Message and send it to ${user.telegramid}`;
                    console.log(`   - Preparing to send ${cat.name} content to Telegram ID ${user.telegramid}...`);
                    try {
                        await postMessage(telegramWorkspaceId, telegramAgentId, prompt);
                        console.log(`     - Successfully posted request to send ${cat.name} to Telegram agent.`);
                        anyTelegramPostSucceededThisRun = true;

                        console.log(`     - Waiting ${config.telegramPostDelayMs / 1000}s before next Telegram send...`);
                        await wait(config.telegramPostDelayMs);

                    } catch (error) {
                        console.error(`     - FAILED to post ${cat.name} message request to Telegram agent: ${error.message}`);
                    }
                } else {
                    console.log(`   - Skipping Telegram send for ${cat.name}: Content is placeholder or error.`);
                }
            }

            if (anyTelegramPostSucceededThisRun) {
                 console.log(` -> [${user.user_email}] At least one Telegram message request succeeded.`);
            } else {
                 console.log(` -> [${user.user_email}] No valid content found to send to Telegram this run.`);
            }
        } else {
            console.log(`   - Skipping Telegram send: Last sent time (${user.tele_last_sent ? new Date(user.tele_last_sent).toISOString() : 'never'}) is within ${config.telegramSendIntervalHours} hours.`);
        }
         console.log(` -> [${user.user_email}] Telegram Sending Check Finished.`);
    } else {
         console.log(` -> [${user.user_email}] Skipping Telegram Sending (Agent/Workspace not configured or user has no Telegram ID).`);
    }


    if (openServIntelProcessingAttempted || openServSocialProcessingAttempted || isForcedRun) {
        updates.last_job = new Date().toISOString();
    }
    if (geminiProcessingAttempted && anyGeminiCallSucceededThisRun) {
        updates.ai_last_update = new Date().toISOString();
    }
    if (canSendTelegram && anyTelegramPostSucceededThisRun) {
         updates.tele_last_sent = new Date().toISOString();
    }


    const updateKeys = Object.keys(updates);
    if (updateKeys.length === 0) {
        console.log(` -> [${user.user_email}] No changes to save, skipping Supabase update.`);
        return true;
    }

    let supabaseUpdateSuccess = false;
    try {
        console.log(` -> Updating Supabase for ${user.user_email} with keys: ${updateKeys.join(', ')}`);
        const { error: updateError } = await supabase.from('user_preferences').update(updates).eq('user_email', user.user_email);
        if (updateError) {
            console.error(`!!! [${user.user_email}] Supabase update FAILED:`, updateError.message);
            console.error(`    Failed payload keys: ${updateKeys.join(', ')}`);
        } else {
            console.log(` -> [${user.user_email}] Supabase update successful.`);
            supabaseUpdateSuccess = true;
        }
    } catch (error) {
        console.error(` -> [${user.user_email}] CRITICAL Supabase Operation Error:`, error.message, error.stack);
    }
    return supabaseUpdateSuccess;
};
