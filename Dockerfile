FROM node:18-slim

RUN apt-get update && apt-get install -y python3 python3-pip python3-dev gcc && rm -rf /var/lib/apt/lists/*

RUN pip3 install instagrapi==2.1.2 Pillow requests --break-system-packages

WORKDIR /app

COPY . .

RUN npm install

RUN mkdir -p downloads

EXPOSE 3001
CMD ["node", "server.js"]
