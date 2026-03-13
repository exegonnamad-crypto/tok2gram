FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p downloads
EXPOSE 3001
CMD ["node", "server.js"]
