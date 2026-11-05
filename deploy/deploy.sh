#!/usr/bin/env bash
# Deploy / update FQD on the VPS.
# Run from the repo root after `npm run build`:  bash deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/fqd
DOMAIN="${DOMAIN:?set DOMAIN=your-domain}"

echo "==> Installing files to $APP_DIR"
sudo mkdir -p "$APP_DIR/server/dist" "$APP_DIR/web/dist" "$APP_DIR/data"
sudo cp server/dist/server.mjs "$APP_DIR/server/dist/"
sudo cp -r web/dist/. "$APP_DIR/web/dist/"

if [ ! -f "$APP_DIR/server/.env" ]; then
  echo "==> Creating server/.env (edit the password & secret!)"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  sudo tee "$APP_DIR/server/.env" >/dev/null <<ENV
ADMIN_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
APP_SECRET=$SECRET
PORT=8795
POLL_INTERVAL_MIN=10
DATA_DIR=$APP_DIR/data
WEB_DIR=$APP_DIR/web/dist
ENV
  echo "    --> Generated password:"
  sudo grep ADMIN_PASSWORD "$APP_DIR/server/.env"
fi

echo "==> systemd service"
sudo cp deploy/fqd.service /etc/systemd/system/fqd.service
sudo systemctl daemon-reload
sudo systemctl enable --now fqd
sudo systemctl restart fqd

if [ ! -f /etc/nginx/sites-enabled/fqd ]; then
  echo "==> nginx vhost for $DOMAIN"
  sudo sed "s/limits.example.com/$DOMAIN/" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/fqd >/dev/null
  sudo ln -sf /etc/nginx/sites-available/fqd /etc/nginx/sites-enabled/fqd
  sudo nginx -t && sudo systemctl reload nginx
  echo "==> TLS via certbot"
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" --redirect || true
fi

echo "==> Done. https://$DOMAIN"
sudo systemctl --no-pager status fqd | head -5
