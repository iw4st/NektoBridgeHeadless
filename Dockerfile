FROM ubuntu:22.04

# Install required packages
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    ffmpeg \
    libavformat-dev libavcodec-dev libavdevice-dev libavutil-dev libswscale-dev libswresample-dev libavfilter-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Set working directory
WORKDIR /app

# Copy the entire NektoBridge folder to /app
COPY . .

# Install Python dependencies
RUN pip3 install -r requirements.txt

# Install Node.js dependencies
WORKDIR /app/bot
RUN npm install

# Go back to /app
WORKDIR /app

# Expose WebSocket port (optional, Render handles this)
EXPOSE 8080

# Make start script executable
RUN chmod +x start.sh

# Start the application
CMD ["./start.sh"]
