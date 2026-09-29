FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y python3 ffmpeg \
    && pip3 install --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]