
FROM node:22-bookworm

WORKDIR /app

# Install Python, pip and FFmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with its recommended dependencies
RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    -U "yt-dlp[default]"

# Verify the installation and runtime
RUN python3 --version \
    && node --version \
    && yt-dlp --version \
    && python3 -m yt_dlp --version

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the application
COPY . .

EXPOSE 10000

CMD ["npm", "start"]
