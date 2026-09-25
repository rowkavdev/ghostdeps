# Build the workspace so the runtime image contains only the app and its
# production dependencies. The pinned pnpm version comes from package.json.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
    && pnpm --filter @ghostdeps/github-app deploy --prod /opt/ghostdeps

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /opt/ghostdeps/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["./node_modules/.bin/probot", "run", "./dist/index.js"]
