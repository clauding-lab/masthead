#!/bin/bash
cd /tmp/masthead-dev
node server.js &
exec ./node_modules/.bin/vite --host
