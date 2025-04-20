// openservClient.js
import axios from 'axios';
import config from './config.js';

const BASE_URL = 'https://api.openserv.ai';

// Reusable axios instance with default headers
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'accept': 'application/json', // Default, will be overridden where needed
    'x-openserv-key': config.openservApiKey,
  },
  timeout: 30000, // Add a timeout (30 seconds)
});

/**
 * Posts a message to a specific agent chat.
 */
export const postMessage = async (workspaceId, agentId, message) => {
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/message`;
  console.log(`POST ${url} for agent ${agentId} in workspace ${workspaceId}`);
  try {
    const response = await apiClient.post(url, { message }, {
        headers: {
            'Content-Type': 'application/json',
            'accept': '*/*' // Endpoint specific override
        }
    });
    console.log(` -> POST ${url} successful.`);
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    console.error(` -> Error POSTing to ${url}: ${error.code} - ${errorMsg}`);
    throw new Error(`OpenServ POST failed: ${errorMsg}`); // Throw a cleaner error
  }
};

/**
 * Retrieves messages from a specific agent chat.
 */
export const getMessages = async (workspaceId, agentId) => {
  const url = `/workspaces/${workspaceId}/agent-chat/${agentId}/messages`;
  console.log(`GET ${url} for agent ${agentId} in workspace ${workspaceId}`);
  const headers = {
      'accept': 'application/json', // Correct header for this endpoint
  };
  if (config.openservConnectSid) {
      headers['cookie'] = `connect.sid=${config.openservConnectSid}`;
  } else {
      console.warn(` -> GET ${url}: Missing connect.sid cookie. Request might fail authentication.`);
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
        console.error(`   (Attempted request with connect.sid cookie)`);
    }
    throw new Error(`OpenServ GET failed: ${errorMsg}`);
  }
};

/**
 * Utility to extract the last agent message from a list.
 */
export const getLastAgentMessage = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.author === 'agent' && messages[i]?.message) {
            console.log(`   Found last agent message (ID: ${messages[i].id})`);
            return messages[i].message;
        }
    }
    console.log("   No agent message found in the retrieved history.");
    return null;
};

// Helper function for waiting
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
