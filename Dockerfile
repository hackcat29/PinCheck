# PinCheck web workbench. No npm dependencies; the image only needs Node.js.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY package.json server.mjs cli.mjs ./
COPY src ./src
COPY web ./web
COPY docs ./docs
COPY examples ./examples
COPY demo ./demo
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1
CMD ["node", "server.mjs"]
