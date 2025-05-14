
UUID := planify-tray@sagarduwal.github.com
INSTALL_PATH := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all clean install uninstall enable disable

all: build

build: clean metadata.json
	rm -rf temp
	mkdir -p temp
	cp metadata.json temp
	cp -r assets temp
	cp *.js temp
	cp *.css temp

clean:
	rm -rf temp

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

install:
	mkdir -p $(INSTALL_PATH)
	cp -r * $(INSTALL_PATH)

uninstall:
	rm -rf $(INSTALL_PATH)
	make restart

dist: all
	zip -qr "../${UUID}.zip" .

log:
	journalctl -o cat -n 0 -f "$$(which gnome-shell)" | grep -v warning