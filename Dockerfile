FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

WORKDIR /app

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile

EXPOSE 4142

CMD ["pnpm", "run", "wisp-server"]
