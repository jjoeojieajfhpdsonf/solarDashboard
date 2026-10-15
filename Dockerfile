FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/solar.db
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
