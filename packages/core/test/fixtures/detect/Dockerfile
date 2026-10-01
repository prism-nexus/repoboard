FROM node:20-slim AS base
WORKDIR /app
COPY . .
RUN pnpm install
CMD ["pnpm", "start"]
