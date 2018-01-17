CXX=g++
CXXFLAGS=-g -Wall -O3

ifndef PNGCRUSH
  PNGCRUSH:=$(shell command -v pngcrush 2>/dev/null)
endif
ifndef PNGCRUSH
  PNGCRUSH:=mv
endif

all: dep quasar quasar.templates.js icons

quasar: LDFLAGS=-lfcgi -lsqlite3 -luriparser

clean:
	rm -f quasar *.o quasar.*.png

quasar.templates.js: templates/*.handlebars
	handlebars -f $@ $^

icons: quasar.16.png quasar.32.png quasar.48.png quasar.64.png quasar.180.png
icons: quasar.ico apple-touch-icon-precomposed.png

%.png: %.png.tmp
ifeq "$(PNGCRUSH)" "mv"
	$(warning Optional dependency pngcrush is not installed)
endif
	$(PNGCRUSH) $^ $@

quasar.%.png.tmp: quasar.svg
	inkscape -e $@ -w $* $<

apple-touch-icon-precomposed.png: quasar.180.png
	convert "$^" -background '#eee' -alpha remove -alpha off "$@"

quasar.ico:
	convert quasar.16.png quasar.32.png quasar.48.png quasar.64.png quasar.ico

dep: jquery-3.2.1.min.js jquery-3.2.1.min.map handlebars.runtime-v4.0.10.js Font-Awesome-4.7.0

jquery-3.2.1.min.js:
	wget -O $@ https://code.jquery.com/jquery-3.2.1.min.js
jquery-3.2.1.min.map:
	wget -O $@ https://code.jquery.com/jquery-3.2.1.min.map
handlebars.runtime-v4.0.10.js:
	wget -O $@ https://s3.amazonaws.com/builds.handlebarsjs.com/handlebars.runtime-v4.0.10.js
Font-Awesome-4.7.0:
	rm -rf Font-Awesome-4.7.0
	wget -O- https://github.com/FortAwesome/Font-Awesome/archive/v4.7.0.tar.gz | tar xzf - Font-Awesome-4.7.0/css Font-Awesome-4.7.0/fonts
