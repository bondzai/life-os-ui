FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
COPY drizzle.config.ts ./
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]
