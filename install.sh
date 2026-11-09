#!/bin/sh
# Instala a Vitrine no menu de aplicativos do Ubuntu (só para o seu usuário).
#   ./install.sh           instala / atualiza
#   ./install.sh --remove  remove
set -e

APP_ID=io.github.vitrine.Loja
SRC="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/vitrine"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor/scalable/apps"
BIN="$HOME/.local/bin"

if [ "$1" = "--remove" ]; then
  rm -rf "$DEST" "$APPS/$APP_ID.desktop" "$ICONS/$APP_ID.svg" "$BIN/vitrine"
  update-desktop-database "$APPS" 2>/dev/null || true
  echo "Vitrine removida."
  exit 0
fi

command -v gjs >/dev/null 2>&1 || { echo "Falta o gjs:  sudo apt install gjs"; exit 1; }
gjs -c "imports.gi.versions.WebKit2 = '4.1'; imports.gi.WebKit2;" >/dev/null 2>&1 || {
  echo "Falta o WebKitGTK:  sudo apt install gir1.2-webkit2-4.1"; exit 1; }
gjs -c "imports.gi.versions.Soup = '3.0'; imports.gi.Soup;" >/dev/null 2>&1 || {
  echo "Falta o libsoup:  sudo apt install gir1.2-soup-3.0"; exit 1; }
command -v script >/dev/null 2>&1 || { echo "Falta o util-linux (comando script)"; exit 1; }

mkdir -p "$DEST" "$APPS" "$ICONS" "$BIN"
if [ "$SRC" != "$DEST" ]; then
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -r "$SRC/main.js" "$SRC/vitrine" "$SRC/ui" "$DEST/"
fi
chmod +x "$DEST/vitrine"
ln -sf "$DEST/vitrine" "$BIN/vitrine"
cp "$SRC/ui/icon.svg" "$ICONS/$APP_ID.svg"

cat > "$APPS/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Vitrine
GenericName=Loja de aplicativos
Comment=Instale apps do Flathub com um clique
Exec=$DEST/vitrine
Icon=$APP_ID
Terminal=false
Categories=System;PackageManager;GTK;
Keywords=loja;store;apps;aplicativos;flatpak;flathub;instalar;
StartupNotify=true
StartupWMClass=$APP_ID
EOF

update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" 2>/dev/null || true
echo "✓ Vitrine instalada em $DEST"
echo "  Abra pelo menu de aplicativos (procure por \"Vitrine\") ou rode: vitrine"
