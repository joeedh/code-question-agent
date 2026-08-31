FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install git --no-install-recommends python3 python3-venv make g++ \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate
RUN mkdir -p /workspaces/code-question-agent && chown node:node /workspaces/code-question-agent

USER node
