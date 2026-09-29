FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y python3 python3-pip ffmpeg \
    && pip3 install --break-system-packages "yt-dlp[default]" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]