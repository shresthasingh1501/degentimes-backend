// ================================================
// FILE: processTelegramUser.js
// ================================================
import { supabase } from './supabaseClient.js';
import { postMessage } from './openservClient.js';
import { processUser } from './processUser.js';
import config from './config.js';

const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

function isValidContent(content) {
    return content && content !== PLACEHOLDER_MESSAGE && !content.startsWith(ERROR_FETCHING_PREFIX);
}

function hasValidContentForTelegram(user) {
     return isValidContent(user.watchlist) || isValidContent(user.sector) || isValidContent(user.narrative);
}

function isContentStale(user) {
     if (!user.last_job) return true;
     const lastJobTime = new Date(user.last_job);
     const threshold = new Date(Date.now() - config.jobRefreshHours * 60 * 60 * 1000);
     return lastJobTime < threshold;
}

function shouldAttemptTelegramSend(user) {
    if (!user || !user.ispro || !user.telegramid) {
        return false;
    }

    if (!hasValidContentForTelegram(user)) {
        return false;
    }

    if (user.tele_last_sent) {
        const lastSentTime = new Date(user.tele_last_sent);
        const threshold = new Date(Date.now() - config.jobRefreshHours * 60 * 60 * 1000);
        if (lastSentTime >= threshold) {
            return false;
        }
    }
    return true;
}

export const processTelegramUser = async (user, usersCurrentlyProcessingContent) => {
    if (!user || !user.ispro || !user.telegramid) {
        return;
    }

    let currentUserData = user;

    if (isContentStale(currentUserData)) {
        if (usersCurrentlyProcessingContent.has(currentUserData.user_email)) {
             // console.log(` -> [TG/${currentUserData.user_email}] Content processing already in progress, skipping Telegram for now.`);
             return;
        }
        console.log(` -> [TG/${currentUserData.user_email}] Content is stale. Triggering refresh...`);
        usersCurrentlyProcessingContent.add(currentUserData.user_email); // Lock
        let refreshSuccessful = false;
        try {
            refreshSuccessful = await processUser(currentUserData, true); // Force run
        } catch (refreshError) {
            console.error(` -> [TG/${currentUserData.user_email}] Error during forced content refresh: ${refreshError.message}.`);
        } finally {
            usersCurrentlyProcessingContent.delete(currentUserData.user_email); // Unlock
        }

        if (refreshSuccessful) {
             // console.log(` -> [TG/${currentUserData.user_email}] Content refresh successful. Refetching data...`);
            const { data: refreshedUser, error: fetchError } = await supabase
                .from('user_preferences')
                .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro, last_job')
                .eq('user_email', currentUserData.user_email)
                .single();

            if (fetchError || !refreshedUser) {
                console.error(` -> [TG/${currentUserData.user_email}] Error refetching user data after refresh: ${fetchError?.message || 'User not found'}. Skipping Telegram send.`);
                return;
            }
            currentUserData = refreshedUser;
        } else {
             console.warn(` -> [TG/${currentUserData.user_email}] Content refresh failed or skipped. Skipping Telegram send.`);
             return;
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
        return;
    }

    const prompt = `this is the news for today {${combinedNews}} form a concise message from this and send it to user id {${currentUserData.telegramid}} , title it as Degen Times - Daily Digest`;

    let postAttempted = false;
    try {
        await postMessage(
            config.openservWorkspaceIdTelegram,
            config.openservAgentIdTelegram,
            prompt
        );
        postAttempted = true;
    } catch (error) {
        postAttempted = true;
        console.error(` -> [TG/${currentUserData.user_email}] Error sending POST to Telegram agent: ${error.message}`);
    }

    if (postAttempted) {
        try {
            const newTimestamp = new Date().toISOString();
            const { error: updateError } = await supabase
                .from('user_preferences')
                .update({ tele_last_sent: newTimestamp })
                .eq('user_email', currentUserData.user_email);

            if (updateError) {
                throw updateError;
            }
        } catch (error) {
            console.error(` -> [TG/${currentUserData.user_email}] Error updating tele_last_sent in Supabase:`, error.message);
        }
    }
};
