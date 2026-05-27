FROM node:24-bookworm-slim

# mediasoup needs these to compile its C++ worker
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm i --legacy-peer-deps

COPY . .

EXPOSE 3000
EXPOSE 20000-20100/udp

CMD ["node", "server.js"]
