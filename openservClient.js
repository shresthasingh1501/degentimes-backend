// openservClient.js
import axios from 'axios';
import config from './config.js';

const BASE_URL = 'https://api.openserv.ai';

// Reusable axios instance with default headers for general content
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'accept': 'application/json',
    'x-openserv-key': config.openservApiKey,
  },
  timeout: 30000, // 30 seconds
});

// --- Standard OpenServ Client Functions ---
export const postMessage = async (workspaceId, agentId, message) => {
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/message`;
  console.log(`POST ${url} for agent ${agentId} in workspace ${workspaceId}`);
  try {
    const response = await apiClient.post(url, { message }, {
        headers: {
            'Content-Type': 'application/json',
            'accept': '*/*'
        }
    });
    console.log(` -> POST ${url} successful.`);
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    console.error(` -> Error POSTing to ${url}: ${error.code} - ${errorMsg}`);
    throw new Error(`OpenServ POST failed: ${errorMsg}`);
  }
};

export const getMessages = async (workspaceId, agentId) => {
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/messages`;
  console.log(`GET ${url} for agent ${agentId} in workspace ${workspaceId}`);
  const headers = { 'accept': 'application/json' };
  if (config.openservConnectSid) {
      headers['cookie'] = `connect.sid=${config.openservConnectSid}`;
  } else {
      // console.warn(` -> GET ${url}: Missing general connect.sid cookie. Request might fail authentication if endpoint requires it.`);
  }

  try {
    const response = await apiClient.get(url, { headers });
    const messages = response.data?.messages || [];
    console.log(` -> GET ${url} successful. Received ${messages.length} messages.`);
    return messages;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    console.error(` -> Error GETting from ${url}: ${error.code} - ${errorMsg}`);
    if (config.openservConnectSid) {
        // console.error(`   (Attempted request with general connect.sid cookie)`);
    }
    throw new Error(`OpenServ GET failed: ${errorMsg}`);
  }
};


// --- Twitter-Specific OpenServ Client Functions ---
let twitterApiClient;
if (config.openservTwitterApiKey && config.openservTwitterConnectSid && config.openservTwitterAgentId) {
    twitterApiClient = axios.create({
        baseURL: BASE_URL,
        headers: {
            'accept': 'application/json',
            'x-openserv-key': config.openservTwitterApiKey, // Specific Twitter API Key
        },
        timeout: 45000, // Potentially longer timeout for Twitter agent
    });
    console.log("[OpenServClient] Twitter API client initialized.");
} else {
    console.warn("[OpenServClient] Twitter API client not initialized. Required Twitter configurations (API Key, Connect SID, Agent ID) are missing.");
}


export const postMessageToTwitterAgent = async (workspaceId, agentId, message) => {
  if (!twitterApiClient) {
      console.error("Twitter API client not initialized. Cannot POST message.");
      throw new Error("Twitter API client not initialized.");
  }
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/message`;
  console.log(`POST_TWITTER ${url} for agent ${agentId} in workspace ${workspaceId}`);
  try {
    const response = await twitterApiClient.post(url, { message }, {
        headers: {
            'Content-Type': 'application/json',
            'accept': '*/*'
        }
    });
    console.log(` -> POST_TWITTER ${url} successful.`);
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    console.error(` -> Error POSTing to Twitter ${url}: ${error.code} - ${errorMsg}`);
    throw new Error(`OpenServ Twitter POST failed: ${errorMsg}`);
  }
};

export const getMessagesFromTwitterAgent = async (workspaceId, agentId) => {
  if (!twitterApiClient) {
    console.error("Twitter API client not initialized. Cannot GET messages.");
    throw new Error("Twitter API client not initialized.");
  }
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/messages`;
  console.log(`GET_TWITTER ${url} for agent ${agentId} in workspace ${workspaceId}`);
  const headers = {
      'accept': 'application/json',
      // Twitter connect.sid is mandatory for GET requests to its agent
      'cookie': `connect.sid=${config.openservTwitterConnectSid}`
  };

  try {
    const response = await twitterApiClient.get(url, { headers });
    const messages = response.data?.messages || [];
    console.log(` -> GET_TWITTER ${url} successful. Received ${messages.length} messages.`);
    return messages;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    console.error(` -> Error GETting from Twitter ${url}: ${error.code} - ${errorMsg}`);
    throw new Error(`OpenServ Twitter GET failed: ${errorMsg}`);
  }
};

// --- Common Utility Functions ---
export const getLastAgentMessage = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.author === 'agent' && messages[i]?.message) {
            // console.log(`   Found last agent message (ID: ${messages[i].id})`);
            return messages[i].message;
        }
    }
    // console.log("   No agent message found in the retrieved history.");
    return null;
};

export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
