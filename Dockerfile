FROM node:22-bookworm

WORKDIR /app

# Install Python, pip and ffmpeg
RUN apt-get update \
    && apt-get install -y python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp

# Verify yt-dlp actually exists during the Docker build
RUN yt-dlp --version

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the application
COPY . .

EXPOSE 10000

CMD ["npm", "start"]