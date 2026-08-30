#!/usr/bin/env sh
#
# Serverga chiqarish.
#
# NEGA GITHUB ORQALI EMAS
#
# Serverda GitHub uchun kalit yo'q va repo private. U yerda `git fetch`
# "could not read Username" bilan yiqiladi, lekin `pm2 restart` baribir
# muvaffaqiyatli chiqadi — deploy bo'lgandek ko'rinadi, aslida eski kod
# qayta ko'tariladi. Bu bir marta e'tibordan chetda qolgan.
#
# Shuning uchun kod GitHub'ga emas, to'g'ridan-to'g'ri serverning o'ziga
# push qilinadi. Server repo'sida `receive.denyCurrentBranch=updateInstead`
# yoqilgan, ya'ni push ish daraxtini ham yangilaydi. Ulanish
# ~/.ssh/config dagi "anitoku-server" nomi va anitoku_server kaliti
# orqali — parol kerak emas.
#
# GitHub asosiy nusxa bo'lib qoladi: `git push origin main` alohida.

set -e

REMOTE=server
BRANCH=main
APP=anitoku-agent
DIR=/var/www/anitoku-agent

echo "→ serverga push qilinmoqda…"
git push "$REMOTE" "$BRANCH"

echo "→ qayta ishga tushirilmoqda…"
ssh anitoku-server "bash -lc '
  export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  cd $DIR
  echo \"serverdagi HEAD: \$(git log --oneline -1)\"
  pm2 restart $APP --update-env >/dev/null
  sleep 8
  pm2 list | grep $APP
'"

echo "→ tayyor."
