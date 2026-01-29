FROM mcr.microsoft.com/playwright:v1.56.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENTRYPOINT ["node", "src/index.js"]