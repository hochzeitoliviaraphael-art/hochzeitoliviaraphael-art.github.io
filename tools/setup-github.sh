#!/usr/bin/env bash
# Legt Repo, Secret und GitHub Pages für die Upload-Seite an und veröffentlicht sie.
# Voraussetzung: GitHub CLI (https://cli.github.com) und `gh auth login` mit dem
# Konto hochzeitoliviaraphael-art. Aufruf im Projektordner: bash tools/setup-github.sh
set -euo pipefail

OWNER="hochzeitoliviaraphael-art"
REPO="${OWNER}.github.io"          # ergibt die kurze Adresse https://${OWNER}.github.io/

login="$(gh api user --jq .login)"
if [ "$login" != "$OWNER" ]; then
  echo "Angemeldet als '$login', erwartet '$OWNER'. Bitte 'gh auth login' mit dem Hochzeitskonto." >&2
  exit 1
fi

read -r -p "Apps-Script-Adresse (https://script.google.com/macros/s/<ID>/exec): " APPS_SCRIPT_URL
if ! [[ "$APPS_SCRIPT_URL" =~ ^https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,200}/exec$ ]]; then
  echo "Falsches Format. Ohne /u/<Zahl>/ und ohne ?k=..." >&2
  exit 1
fi

if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --public --description "Foto-Upload für die Hochzeit"
fi

# Die Script-Adresse als Secret, nicht im Code
printf '%s' "$APPS_SCRIPT_URL" | gh secret set APPS_SCRIPT_URL --repo "$OWNER/$REPO"

# GitHub Pages über GitHub Actions veröffentlichen
gh api -X POST "repos/$OWNER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" -f build_type=workflow >/dev/null

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
git push -u origin main

echo "Warte auf die Veröffentlichung ..."
sleep 5
gh run watch --repo "$OWNER/$REPO" --exit-status "$(gh run list --repo "$OWNER/$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "Fertig: https://$REPO/?k=<ACCESS_CODE>"
