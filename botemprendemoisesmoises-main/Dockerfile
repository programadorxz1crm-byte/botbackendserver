FROM node:20-alpine
WORKDIR /app

# Install dependencies first (better caching)
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --production

# Copy source
COPY . ./

# Default port inside container
ENV PORT=3000
EXPOSE 3000

# Ensure required dirs exist (will be mounted for persistence)
RUN mkdir -p /app/auth /app/data

CMD ["node", "index.js"]