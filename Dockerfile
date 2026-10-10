FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Seoul

WORKDIR /app

COPY app.mjs package.json ./

CMD ["node", "app.mjs"]
