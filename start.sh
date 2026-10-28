#!/bin/sh
set -u

# Start the private PO-token provider and keep its log visible in Render's log stream.
if [ -f /opt/bgutil/build/main.js ]; then
  node /opt/bgutil/build/main.js --host 127.0.0.1 > /tmp/bgutil-provider.log 2>&1 &
  BGUTIL_PID=$!

  # Wait up to 20s for the provider to answer instead of a blind sleep.
  i=0
  while [ $i -lt 20 ]; do
    if curl -fsS --max-time 1 http://127.0.0.1:4416/ping >/dev/null 2>&1; then
      echo "bgutil provider is up"
      break
    fi
    if ! kill -0 "$BGUTIL_PID" 2>/dev/null; then
      echo "bgutil provider EXITED early. Its log:"
      cat /tmp/bgutil-provider.log
      break
    fi
    i=$((i + 1)); sleep 1
  done
  if [ $i -ge 20 ]; then
    echo "bgutil provider did not answer on :4416 within 20s. Its log:"
    cat /tmp/bgutil-provider.log
  fi
else
  echo "WARNING: /opt/bgutil/build/main.js not found - PO-token provider is NOT running"
fi

# Start the API either way; extraction will log clearly if the provider is missing.
exec npm start
