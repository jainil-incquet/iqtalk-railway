#!/bin/sh
# entrypoint.sh

echo "🔹 Detecting Public IP..."
export ANNOUNCED_IP=$(curl -s https://ipify.org)
echo "✅ Public IP detected: $ANNOUNCED_IP"

# Start the application
exec "$@"
