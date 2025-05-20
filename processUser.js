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

function shouldAttemptTelegramSend(user, isInitialSend = false) {
    if (!user || !user.ispro || !user.telegramid) {
        return false;
    }

    if (!hasValidContentForTelegram(user)) {
        // console.log(` -> [TG/${user.user_email}] No valid content for Telegram.`);
        return false;
    }

    if (isInitialSend) { // For initial send, if content is valid, proceed
        // console.log(` -> [TG/${user.user_email}] Initial send attempt, bypassing time check.`);
        return true;
    }

    // Regular send logic
    if (user.tele_last_sent) {
        const lastSentTime = new Date(user.tele_last_sent);
        // Use telegramSendIntervalHours for regular sends
        const threshold = new Date(Date.now() - config.telegramSendIntervalHours * 60 * 60 * 1000);
        if (lastSentTime >= threshold) {
            // console.log(` -> [TG/${user.user_email}] Regular send skipped, last sent too recent.`);
            return false;
        }
    }
    return true;
}

export const processTelegramUser = async (user, usersCurrentlyProcessingContent, isInitialSend = false) => {
    if (!user || !user.ispro || !user.telegramid) {
        return;
    }

    let currentUserData = { ...user }; // Work with a copy

    // console.log(` -> [TG/${currentUserData.user_email}] Processing. Initial: ${isInitialSend}`);

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
                .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro, last_job') // Ensure all needed fields are here
                .eq('user_email', currentUserData.user_email)
                .single();

            if (fetchError || !refreshedUser) {
                console.error(` -> [TG/${currentUserData.user_email}] Error refetching user data after refresh: ${fetchError?.message || 'User not found'}. Skipping Telegram send.`);
                return;
            }
            currentUserData = refreshedUser; // Update with the latest data
        } else {
             console.warn(` -> [TG/${currentUserData.user_email}] Content refresh failed or skipped. Skipping Telegram send.`);
             return;
        }
    }

    if (!shouldAttemptTelegramSend(currentUserData, isInitialSend)) {
        // console.log(` -> [TG/${currentUserData.user_email}] Final check: Skipping Telegram send (initial: ${isInitialSend}).`);
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
        // console.log(` -> [TG/${currentUserData.user_email}] No combined news to send.`);
        return;
    }

    const prompt = `this is the news for today {${combinedNews}} form a concise message from this and send it to user id {${currentUserData.telegramid}} , title it as Degen Times - Daily Digest`;

    let postAttempted = false;
    try {
        console.log(` -> [TG/${currentUserData.user_email}] Attempting to send message via OpenServ...`);
        await postMessage(
            config.openservWorkspaceIdTelegram,
            config.openservAgentIdTelegram,
            prompt
        );
        postAttempted = true;
        console.log(` -> [TG/${currentUserData.user_email}] Successfully sent message via OpenServ.`);
    } catch (error) {
        postAttempted = true; // Attempt was made
        console.error(` -> [TG/${currentUserData.user_email}] Error sending POST to Telegram agent: ${error.message}`);
    }

    if (postAttempted) { // Update tele_last_sent regardless of OpenServ success for this attempt
        try {
            const newTimestamp = new Date().toISOString();
            // console.log(` -> [TG/${currentUserData.user_email}] Updating tele_last_sent to ${newTimestamp}.`);
            const { error: updateError } = await supabase
                .from('user_preferences')
                .update({ tele_last_sent: newTimestamp })
                .eq('user_email', currentUserData.user_email);

            if (updateError) {
                throw updateError; // Let the outer catch handle this
            }
        } catch (error) {
            console.error(` -> [TG/${currentUserData.user_email}] Error updating tele_last_sent in Supabase:`, error.message);
        }
    }
};
