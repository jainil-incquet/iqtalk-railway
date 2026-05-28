FROM node:18-slim

# Install curl for IP discovery and build tools for mediasoup
RUN apt-get update && apt-get install -y curl python3 make g++ gcc

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Make the script executable
RUN chmod +x entrypoint.sh

# Use the script as the entrypoint
ENTRYPOINT ["./entrypoint.sh"]
CMD ["npm", "start"]
