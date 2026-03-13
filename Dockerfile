FROM node:18-slim

WORKDIR /app

COPY . .

RUN npm install

RUN mkdir -p downloads

EXPOSE 3001
CMD ["node", "server.js"]
