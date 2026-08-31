FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

# better-sqlite3 (an onlyBuiltDependencies package) compiles a native addon
# on install; comment-lint's postinstall wants a python3 venv.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install git --no-install-recommends python3 python3-venv make g++ \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

# The workspace is a fresh named volume at container start, empty and
# root-owned by default. Pre-creating the mount point here, owned by node,
# makes Docker's volume copy-up carry that ownership onto the volume the
# first time it's mounted, so lifecycle commands can write it as node
# without a runtime chown step.
RUN mkdir -p /workspaces/code-question-agent && chown node:node /workspaces/code-question-agent

USER node
