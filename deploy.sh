#!/bin/bash
echo "Running pre-push checks..."
node --check index.js || { echo "Syntax error in index.js. Push aborted."; exit 1; }
node --check hub.js || { echo "Syntax error in hub.js. Push aborted."; exit 1; }
node --check db.js || { echo "Syntax error in db.js. Push aborted."; exit 1; }
echo "Checks passed. Pushing..."
git add \
  .gitignore \
  deploy.sh \
  db.js \
  hub.js \
  index.js \
  kapa-dine-hub.html \
  package.json \
  package-lock.json
git commit -m "$1"
git push
echo "Deployed successfully!"
