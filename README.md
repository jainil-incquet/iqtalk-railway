# IQTalk — Railway Deployment

One repo, one URL — signaling server + HTML client together.

## Deploy to Railway (3 minutes)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Select the repo — Railway detects Node.js automatically
4. Once deployed, copy your Railway URL:
   e.g. https://iqtalk-production.up.railway.app

5. Open public/index.html and update the 4 config lines:
   SIGNALING_HOST   = 'iqtalk-production.up.railway.app'
   SIGNALING_PORT   = 443
   SIGNALING_PATH   = '/peerjs'
   SIGNALING_SECURE = true

6. Commit and push — Railway redeploys automatically.
7. Open your Railway URL on any device and test.

## Update the client
Edit public/index.html → commit → push → Railway redeploys in ~30 seconds.

## Local dev
  npm install
  node server.js
  # Open http://localhost:3000
  # Set SIGNALING_HOST='localhost', PORT=3000, SIGNALING_SECURE=false
