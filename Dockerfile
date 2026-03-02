FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE ${PORT:-3000}

CMD ["node", "index.js"]
