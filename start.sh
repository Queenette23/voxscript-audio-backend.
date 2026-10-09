#!/bin/sh
set -eu
node /opt/bgutil/build/main.js --host 127.0.0.1 --port 4416 > /tmp/bgutil-provider.log 2>&1 &
sleep 5
exec npm start
