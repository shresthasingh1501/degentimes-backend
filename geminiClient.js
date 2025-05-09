// geminiClient.js
import axios from 'axios';
import config from './config.js';

// BASE_URL now directly points to the service, model selection will be part of the path
const SERVICE_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models`;

const apiClient = axios.create({
  // No baseURL here, we'll construct the full URL per call to be explicit
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 90000, // 90 seconds, Gemini can take time
});

const SYSTEM_PROMPT_TEXT = `You are an expert crypto related news analyst and detailed report writer. Your task is to generate a daily crypto intelligence briefing for crypto natives and degens. The report MUST be titled "Your [TOPIC] Intel Brief: No-BS Edition - [Date]" (replace [Date] with the provided date and Topic must be inferred from the data (only one major topic) ).

**Core Objective:** Synthesize the provided daily data into a single, detailed, insightful, no-BS briefing. Filter out noise, group related stories, provide context ("Why it Matters," "What It Means"), and identify key takeaways. The tone should be direct, professional, yet accessible and slightly edgy for a crypto-savvy audience, also ignore items in input data which are not related to Crypto even slightly , MCP means Model Context Protocol.

**Output Requirements:**

1.  **Format:** The entire output MUST Use headings , bolding , bullet points , and blockquotes if appropriate.
2.  **Title:** Start with the exact title format using # heading:  **Your [Topic] Daily Brief:- [Date]**
3.  **Attribution:** Include the next line **(Built with OpenServ Builder's Playground)** below the title.
4.  **Tagline:** Include the tagline: *No gatekeepers, no ads, no clickbait. Just the signal.* below the attribution.
5.  **Structure:** The report MUST follow a good structure precisely:

**Key Instructions:**

*   **Strictly Adhere to Structure:** Use the exact section headings and order.
*   **Use ONLY Provided Data:** Do not invent information or pull external data. Base the *entire* report on the specific daily data provided as input.
*   **Be Detailed:** Get straight to the point. Avoid fluff and jargon where possible, but use crypto-native terms correctly.
*   **Synthesize and Analyze:** Do not just list data. Connect related items, identify trends, and provide the "why" and "so what."
*   **Maintain Tone:** Keep it informative, direct, slightly edgy, and focused on signal over noise, ignore twitter chatter thats irrelevant focus on official stuff more and dont please dont tag twitter users you can read all of their messages but dont tag them directly read twitter messages as a whole and include them in the main news not as a seperate element

Now, generate the report for **[Date]** 
DONT LIST REFERENCES AND MAKE A BIG BRIEF NOT SMALL
DONT MAKE A REPORT IF NOT ENOUGH DATA about [Topic]"
DONT HAVE INTRO OR OUTRO TEXT LIKE - alright here is your analysis or here is the conclusion , the message should strictly contain report`;

export const getActionableInsights = async (intelContent, socialContent, categoryName) => {
  if (!config.geminiApiKey) {
    console.warn('[GeminiClient] GEMINI_API_KEY is not set. Skipping Gemini processing.');
    return `Error: Gemini API key not configured. Cannot generate insights for ${categoryName}.`;
  }
  if (!config.geminiModelId) { // This check should ideally not fail due to default in config.js
    console.error('[GeminiClient] Critical Error: GEMINI_MODEL_ID is not set, even after default. Check config.js.');
    return `Error: Gemini Model ID not configured internally. Cannot generate insights for ${categoryName}.`;
  }

  let combinedInput = `Category: ${categoryName}\n\n`;
  let hasSubstantiveIntel = false;
  let hasSubstantiveSocial = false;

  if (intelContent && !intelContent.startsWith(config.placeholderMessagePrefix) && !intelContent.startsWith(config.errorFetchingPrefix)) {
    combinedInput += `Intel News:\n${intelContent}\n\n`;
    hasSubstantiveIntel = true;
  } else {
    combinedInput += `Intel News: Not available or contains placeholder/error.\n\n`;
  }

  if (socialContent && !socialContent.startsWith(config.socialPlaceholderPrefix) && !socialContent.startsWith(config.errorFetchingPrefix) && !socialContent.startsWith(config.socialErrorMessagePrefix)) {
    combinedInput += `Twitter Content:\n${socialContent}\n\n`;
    hasSubstantiveSocial = true;
  } else {
    combinedInput += `Twitter Content: Not available or contains placeholder/error.\n\n`;
  }

  if (!hasSubstantiveIntel && !hasSubstantiveSocial) {
    console.log(`[GeminiClient] No substantive intel or social content for ${categoryName} to send to Gemini.`);
  }

  const requestPayload = {
    contents: [
      {
        role: "user",
        parts: [
          { "text": SYSTEM_PROMPT_TEXT },
          { "text": combinedInput }
        ]
      }
    ],
    "generationConfig": {
        "temperature": 0.3,
        "topK": 40,
        "topP": 0.95,
        "maxOutputTokens": 5000,
        "stopSequences": []
    }
  };

  const fullRequestUrl = `${SERVICE_BASE_URL}/${config.geminiModelId}:generateContent?key=${config.geminiApiKey}`;

  console.log(`[GeminiClient] Requesting actionable insights for ${categoryName} using model ${config.geminiModelId}`);

  try {
    const response = await apiClient.post(fullRequestUrl, requestPayload);

    if (response.data && response.data.candidates && response.data.candidates.length > 0) {
      const candidate = response.data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        const textResponse = candidate.content.parts.map(part => part.text).join("");
        if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
            console.warn(`[GeminiClient] Gemini response for ${categoryName} (model: ${config.geminiModelId}) finished with reason: ${candidate.finishReason}.`);
             if (candidate.finishReason === "SAFETY") {
                if (candidate.safetyRatings) console.warn(`[GeminiClient] Safety Ratings: ${JSON.stringify(candidate.safetyRatings)}`);
                return `Error: Gemini content generation for ${categoryName} was blocked due to safety settings. The input or generated content may have triggered a safety filter.`;
             }
        }
        return textResponse;
      }
    }
    console.error(`[GeminiClient] Error: No valid content found in Gemini response for ${categoryName} (model: ${config.geminiModelId}). Response:`, JSON.stringify(response.data, null, 2));
    return `Error: Could not generate actionable insights for ${categoryName} due to an unexpected API response format.`;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    const errorCode = error.response?.data?.error?.code;
    const httpStatus = error.response?.status;

    console.error(`[GeminiClient] Error getting insights for ${categoryName} (model: ${config.geminiModelId}, HTTP Status: ${httpStatus}, API Error Code: ${errorCode}): ${errorMsg}`);
    if (error.response?.data) {
        console.error("[GeminiClient] Full Gemini Error Response:", JSON.stringify(error.response.data, null, 2));
    } else if (httpStatus === 404) {
        console.error(`[GeminiClient] The endpoint with model '${config.geminiModelId}' was not found: ${fullRequestUrl}. Please verify the GEMINI_MODEL_ID and API path.`);
    }
    return `Error: Failed to connect with the AI insights generation service for ${categoryName}. (Status: ${httpStatus}, Message: ${errorMsg})`;
  }
};
