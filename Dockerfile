# Dockerfile

# 1. Base Image: Use an official Node.js LTS version. 'slim' is smaller.
FROM node:18-slim AS base

# Set working directory
WORKDIR /app

# 2. Install Dependencies:
# Copy package.json and package-lock.json (if available) first
# This leverages Docker layer caching - dependencies are only reinstalled
# if these files change.
COPY package*.json ./

# Install production dependencies ONLY
# Use --omit=dev which is the standard in newer npm versions
RUN npm install --omit=dev

# 3. Copy Application Code:
# Copy the rest of your application code into the container
COPY . .

# 4. Runtime Configuration:
# The port the application will listen on (should match fly.toml internal_port and ENV.PORT)
EXPOSE 8080

# Set NODE_ENV to production (good practice)
ENV NODE_ENV=production

# Optional: Add a non-root user for security
# RUN addgroup --system --gid 1001 nodejs
# RUN adduser --system --uid 1001 nodejs
# USER nodejs

# 5. Define the Command to run the application:
# This command starts your worker when the container launches.
# It matches the command in the [processes] section of fly.toml
CMD [ "node", "worker.js" ]
