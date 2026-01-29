FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /runner

RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
RUN chmod +x scripts/*.sh

ENTRYPOINT ["bash", "/runner/scripts/entrypoint.sh"]