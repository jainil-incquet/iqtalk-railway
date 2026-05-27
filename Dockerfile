FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm i --legacy-peer-deps

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm i --legacy-peer-deps

COPY . .

EXPOSE 3000
EXPOSE 20000-20100/udp

CMD ["node", "server.js"]
