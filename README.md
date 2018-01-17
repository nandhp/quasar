Quasar
======

![Quasar Logo](https://user-images.githubusercontent.com/404497/35063426-b19cf18a-fb8c-11e7-8720-d75bd89138c6.png)

A self-hosted browser-based media player for a personal MP3 collection.

* Ultra-lightweight (search backend written in C++ with a SQLite
  database) so it can be hosted even on a low-power NAS box

* Supports cover art in `cover.jpg`, `albumart.jpg` or `folder.jpg` files

* Responsive design for mobile use

* Works with music formats supported by your browser, including MP3
  and M4A (no transcoding)

Dependencies
------------

To compile Quasar, you must have Inkscape, ImageMagick, `wget`, and
Handlebars installed. These programs are used to render the logo,
download JavaScript libraries, and compile the templates file. To
create or update the database, you need Perl with the
`Image::ExifTool` and `DBD::SQLite` modules. These steps are
platform-independent and can be done on any computer, so you don't
need to install Inkscape or Handlebars on your NAS device.

You need SQLite and a C++ compiler (`g++`) to compile the search backend.

Installation
------------

1. Use `make` to download library dependencies, compile the backend,
   and generate static files.

   This requires Inkscape, ImageMagick, `wget`, and Handlebars. It is
   recommended to have `pngcrush` as well, but that is optional.

2. Update the library database by running `updatedb_sql.pl` with two
   arguments. The first argument is the path to the database file to
   create or update; the second is the Music directory to index.

       perl updatedb_sql.pl quasar.db /media/music

3. The Quasar daemon supports either CGI or FastCGI. The environment
   variable `QUASAR_DBFILE` specifies the path to the database file;
   if it is not set, Quasar will use `quasar.db` in the current
   directory.

4. Configure Quasar by creating the file `quasar.config.js`. An
   example configuration file is provided in `quasar.config-example.js`.
   The `QUASAR` variable gives the URL to the search backend. The
   `MUSICDIR` variable specifies the URL to the Music directory.

   The `BRANDING` and `LONG_BRANDING` variables allow the visible name
   of Quasar to be customized for your installation.

Local Testing
-------------

You can test Quasar locally using the basic Python web server.
Assuming `QUASAR = '/cgi-bin/quasar'` in your `quasar.config.js`:

    mkdir -p cgi-bin
    ln -s ../quasar cgi-bin
    python -m CGIHTTPServer

Then open `http://localhost:8000/quasar.html`.
