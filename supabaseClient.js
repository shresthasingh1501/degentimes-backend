// supabaseClient.js
import { createClient } from '@supabase/supabase-js';
import config from './config.js';

// Use Service Key for backend operations
let supabaseInstance = null;

try {
    supabaseInstance = createClient(config.supabaseUrl, config.supabaseServiceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    });
    console.log("Supabase client initialized successfully.");
} catch (error) {
    console.error("FATAL: Failed to initialize Supabase client:", error.message);
    process.exit(1); // Exit if Supabase can't be initialized
}

export const supabase = supabaseInstance;
