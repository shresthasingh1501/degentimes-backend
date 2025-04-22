// processTelegramUser.js
import { supabase } from './supabaseClient.js';
import { postMessage } from './openservClient.js'; // Only need postMessage here
import config from './config.js';

// Re-define placeholder here for independence, or import if preferred
const PLACEHOLDER_MESSAGE = "Please Select A Preference To View Personalized News Here";
const ERROR_FETCHING_PREFIX = "Error fetching";

/**
 * Checks if the content is valid (not null, placeholder, or error).
 * @param {string | null} content - The content string.
 * @returns {boolean} - True if the content is valid, false otherwise.
 */
function isValidContent(content) {
    return content && content !== PLACEHOLDER_MESSAGE && !content.startsWith(ERROR_FETCHING_PREFIX);
}

/**
 * Checks if a Telegram message should be sent to the user.
 */
function shouldSendTelegram(user) {
    // Basic checks
    if (!user || !user.ispro || !user.telegramid) {
        return false; // Must be pro user with a telegram ID
    }

    // Content check: At least one category must have valid content
    const hasValidContent = isValidContent(user.watchlist) || isValidContent(user.sector) || isValidContent(user.narrative);
    if (!hasValidContent) {
        // console.log(` -> [TG/${user.user_email}] Skipping: No valid content found.`);
        return false;
    }

    // Time check
    if (user.tele_last_sent) {
        const lastSentTime = new Date(user.tele_last_sent);
        const threshold = new Date(Date.now() - config.telegramSendIntervalHours * 60 * 60 * 1000);
        if (lastSentTime >= threshold) {
            // console.log(` -> [TG/${user.user_email}] Skipping: Last sent (${lastSentTime.toISOString()}) is within ${config.telegramSendIntervalHours} hours.`);
            return false; // Sent too recently
        }
        // console.log(` -> [TG/${user.user_email}] Eligible: Last sent (${lastSentTime.toISOString()}) is older than ${config.telegramSendIntervalHours} hours.`);
    } else {
        // console.log(` -> [TG/${user.user_email}] Eligible: No previous send record.`);
    }

    // If all checks pass
    return true;
}

/**
 * Processes a single user for Telegram sending: checks eligibility, combines content, sends API request, updates timestamp.
 */
export const processTelegramUser = async (user) => {
    if (!shouldSendTelegram(user)) {
        return; // Don't process if conditions not met
    }

    console.log(`\n--- Processing Telegram Send for: ${user.user_email} (ID: ${user.telegramid}) ---`);

    // --- 1. Combine Valid Content ---
    let combinedNews = "";
    if (isValidContent(user.watchlist)) {
        combinedNews += `\n\n## Watchlist News\n\n${user.watchlist}`;
    }
    if (isValidContent(user.sector)) {
        combinedNews += `\n\n## Sector News\n\n${user.sector}`;
    }
    if (isValidContent(user.narrative)) {
        combinedNews += `\n\n## Narrative News\n\n${user.narrative}`;
    }
    combinedNews = combinedNews.trim();

    if (!combinedNews) {
        // Should not happen due to shouldSendTelegram check, but as a safeguard:
        console.warn(` -> [TG/${user.user_email}] Content combination resulted in empty string despite passing checks. Skipping.`);
        return;
    }

    // --- 2. Construct Prompt ---
    const prompt = `this is the news for today {${combinedNews}} form a concise message from this and send it to user id {${user.telegramid}} , title it as Degen Times - Daily Digest`;

    // --- 3. Send POST Request ---
    let postAttempted = false;
    try {
        console.log(` -> [TG/${user.user_email}] Sending POST request to Telegram agent...`);
        await postMessage(
            config.openservWorkspaceIdTelegram,
            config.openservAgentIdTelegram,
            prompt
        );
        postAttempted = true; // Mark that we attempted the API call
        console.log(` -> [TG/${user.user_email}] POST request successful (message queued by OpenServ).`);

    } catch (error) {
        postAttempted = true; // Still mark as attempted even if it failed
        console.error(` -> [TG/${user.user_email}] Error sending POST to Telegram agent: ${error.message}`);
        // Don't stop the process, proceed to update timestamp
    }

    // --- 4. Update Timestamp ---
    // Update tele_last_sent *if the API call was attempted*, regardless of API success/failure
    // This prevents spamming the user if the OpenServ agent has a temporary issue.
    if (postAttempted) {
        try {
            const newTimestamp = new Date().toISOString();
            console.log(` -> [TG/${user.user_email}] Updating tele_last_sent to ${newTimestamp}...`);
            const { error: updateError } = await supabase
                .from('user_preferences')
                .update({ tele_last_sent: newTimestamp })
                .eq('user_email', user.user_email);

            if (updateError) {
                throw updateError;
            }
            console.log(` -> [TG/${user.user_email}] tele_last_sent updated successfully.`);
        } catch (error) {
            console.error(` -> [TG/${user.user_email}] Error updating tele_last_sent in Supabase:`, error.message);
        }
    } else {
         console.log(` -> [TG/${user.user_email}] Skipping tele_last_sent update as POST was not attempted.`);
    }


    console.log(`--- Finished Processing Telegram Send for: ${user.user_email} ---`);
};
