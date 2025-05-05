import { supabase } from './supabaseClient.js';
import { postMessage } from './openservClient.js';
import { processUser } from './processUser.js';
import config from './config.js';

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

function isValidContent(content) {
    return content && content !== PLACEHOLDER_MESSAGE && !content.startsWith(ERROR_FETCHING_PREFIX) && content.trim().length > 0;
}

function hasValidContentForTelegram(user) {
     const hasWatchlist = isValidContent(user.watchlist);
     const hasSector = isValidContent(user.sector);
     const hasNarrative = isValidContent(user.narrative);
     return hasWatchlist || hasSector || hasNarrative;
}


function isContentStale(user) {
     if (!user.last_job) {
         return true;
     }
     const lastJobTime = new Date(user.last_job);
     const threshold = new Date(Date.now() - config.jobRefreshHours * 60 * 60 * 1000);
     const stale = lastJobTime < threshold;
     return stale;
}

function shouldAttemptTelegramSend(user) {
    if (!user || !user.ispro || !user.telegramid) {
        return false;
    }

    if (!hasValidContentForTelegram(user)) {
         console.log(` -> [TG/${user.user_email}] Skipping Send: No valid content available.`);
        return false;
    }

    if (user.tele_last_sent) {
        const lastSentTime = new Date(user.tele_last_sent);
        const threshold = new Date(Date.now() - config.telegramSendIntervalHours * 60 * 60 * 1000);
        if (lastSentTime >= threshold) {
            return false;
        }
    } else {
    }
    return true;
}


export const processTelegramUser = async (user, usersCurrentlyProcessingContent) => {
    if (!user || !user.ispro || !user.telegramid) {
        return;
    }

    let currentUserData = user;
    const userLogPrefix = ` -> [TG/${currentUserData.user_email}]`;

    if (isContentStale(currentUserData)) {
        if (usersCurrentlyProcessingContent.has(currentUserData.user_email)) {
             return;
        }
        console.log(`${userLogPrefix} Content is stale or potentially missing. Triggering background refresh...`);
        usersCurrentlyProcessingContent.add(currentUserData.user_email);
        let refreshSuccessful = false;
        const refreshStartTime = new Date();

        try {
            await processUser(currentUserData, true);
            console.log(`${userLogPrefix} Background content refresh attempt finished.`);
             const { data: refreshedUser, error: fetchError } = await supabase
                 .from('user_preferences')
                 .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro, last_job')
                 .eq('user_email', currentUserData.user_email)
                 .single();

             if (fetchError || !refreshedUser) {
                 console.error(`${userLogPrefix} Error refetching user data after refresh attempt: ${fetchError?.message || 'User not found'}. Using potentially stale data for this cycle.`);
             } else {
                  if (refreshedUser.last_job && new Date(refreshedUser.last_job) >= refreshStartTime) {
                       console.log(`${userLogPrefix} Content refresh confirmed via refetch. Proceeding with updated data.`);
                       currentUserData = refreshedUser;
                       refreshSuccessful = true;
                  } else {
                       console.warn(`${userLogPrefix} Refetched data, but last_job timestamp suggests refresh might not have completed/updated successfully yet. Using potentially stale data.`);
                       currentUserData = refreshedUser;
                  }
             }

        } catch (refreshError) {
            console.error(`${userLogPrefix} Error during background content refresh trigger: ${refreshError.message}.`);
        } finally {
            usersCurrentlyProcessingContent.delete(currentUserData.user_email);
        }
    }


    if (!shouldAttemptTelegramSend(currentUserData)) {
        return;
    }

    let combinedNews = "";
    if (isValidContent(currentUserData.watchlist)) {
        combinedNews += `\n\n## Watchlist News\n\n${currentUserData.watchlist}`;
    }
    if (isValidContent(currentUserData.sector)) {
        combinedNews += `\n\n## Sector News\n\n${currentUserData.sector}`;
    }
    if (isValidContent(currentUserData.narrative)) {
        combinedNews += `\n\n## Narrative News\n\n${currentUserData.narrative}`;
    }
    combinedNews = combinedNews.trim();

    if (!combinedNews) {
         console.log(`${userLogPrefix} No valid, combined content to send.`);
        return;
    }

    const prompt = `this is the news for today {${combinedNews}} form a very concise and creative message from this and send it to user id {${currentUserData.telegramid}} , title it as Degen Times - Daily Digest`;

    let postSuccessful = false;
    try {
        console.log(`${userLogPrefix} Attempting POST to Telegram agent for user ID ${currentUserData.telegramid}.`);
        await postMessage(
            config.openservWorkspaceIdTelegram,
            config.openservAgentIdTelegram,
            prompt
        );
        console.log(`${userLogPrefix} POST to Telegram agent successful.`);
        postSuccessful = true;
    } catch (error) {
        console.error(`${userLogPrefix} Error sending POST to Telegram agent: ${error.message}`);
        postSuccessful = false;
    }

    if (postSuccessful) {
        const newTimestamp = new Date().toISOString();
        try {
            console.log(`${userLogPrefix} Updating tele_last_sent timestamp to ${newTimestamp}.`);
            const { error: updateError } = await supabase
                .from('user_preferences')
                .update({ tele_last_sent: newTimestamp })
                .eq('user_email', currentUserData.user_email);

            if (updateError) {
                console.error(`!!! ${userLogPrefix} Supabase update for tele_last_sent FAILED:`, updateError.message);
            } else {
                console.log(`${userLogPrefix} Supabase update for tele_last_sent successful.`);
            }
        } catch (error) {
             console.error(`!!! ${userLogPrefix} CRITICAL: Error during Supabase update operation for tele_last_sent:`, error.message);
        }
    } else {
         console.log(`${userLogPrefix} Skipping tele_last_sent update because POST to agent failed.`);
    }
};
