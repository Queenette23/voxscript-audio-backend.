#!/bin/sh
set -eu

# Keep the PO-token provider private inside this container.
node /opt/bgutil/build/main.js --host 127.0.0.1 > /tmp/bgutil-provider.log 2>&1 &

# Give the local provider a moment to start before the first request.
sleep 2

exec npm start
