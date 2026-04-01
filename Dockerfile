FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY server.js ./
COPY public/ ./public/

# Copy questions file (one level up in build context)
COPY quiz_questions.json ./

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
