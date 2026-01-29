FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY scripts ./scripts
RUN chmod +x ./scripts/run-tests.sh

ENTRYPOINT ["bash", "./scripts/run-tests.sh"]