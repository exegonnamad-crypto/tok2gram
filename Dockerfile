FROM node:18-slim

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install instagrapi 2.3.0 + dependencies
RUN pip3 install instagrapi==2.3.0 Pillow requests --break-system-packages

WORKDIR /app

# Install node dependencies
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Create downloads directory
RUN mkdir -p downloads

EXPOSE 3001

CMD ["node", "server.js"]
