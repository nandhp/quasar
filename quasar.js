// Quasar

// FIXME: "Now Playing" implementation
// - Store in NowPlayingListing and access from Player <<<<<
//   - Store all track data in Listing
//   - Easy fetching of track metadata
//   - Player has to consult Listing for next/previous track and metadata
// - Store in Player and use as source for NowPlayingListing
//   - Store all (persistent) player data in Player object
//   - Have to handle metadata loading ourselves - bad
// FIXME:
// - URGENT: URL parsing/form submission/etc. (part of ListingView?)
// - Loading/buffering spinner for player (also for listing)
// - Loop (one/all), shuffle, consume (once Now Playing is separated)
// - Volume control (rationale: relative volume compared to other audio)
// - Is gapless playback possible?
// - Keyboard shortcuts and notifications; BeardedSpice support

//////////////////////////////////////////////////////////////////////
// Listing models

// Class to encapsulate track listing backend
function Listing() {
    this.items = [];
    this.waiters = [];
    this.doneLoading = true;
    this.quasarArgs = null;
    this.displayMode = null;

    // Request handling
    this.req = null;
    this.req_error = false;
}

Listing.prototype._next = function() {
    if ( this.doneLoading ) {
        this._checkWaiters(true); // Not going to load any more
        return true;
    }
    return false;
};
Listing.prototype.next = function() {
    console.error("Unimplemented: Listing.next()");
    this.doneLoading = true;
    this._next();
};

// Locate item i and pass it to the callback function. Load the item
// first, if necessary.
Listing.prototype.get = function(i, callback) {
    if ( i >= 0 && i < this.items.length )
        return callback(this.items[i]);
    else if ( i < 0 || i >= this.items.length ) {
        this.waiters[this.waiters.length] = [i, callback];
        this.next();            // FIXME: Handle failure of next
    }
    else {
        console.log("Invalid index for listing: " + i);
        return callback(undefined);
    }
};
Listing.prototype._checkWaiters = function(include_next) {
    var calls = [];
    for ( var i = 0; i < this.waiters.length; /* */ ) {
        var w = this.waiters[i];
        if ( (w[0] >= 0 && w[0] < this.items.length) ||
             (w[0] < 0 && include_next) || this.doneLoading ) {
            this.waiters.splice(i, 1);
            calls[calls.length] = w;
        }
        else
            i++;
    }
    var skipped = this.waiters.length; // Number of leftover waiters
    for ( i = 0; i < calls.length; i++ ) {
        calls[i][1](calls[i][0] >= 0 && calls[i][0] < this.items.length ?
                    this.items[calls[i][0]] : null);
    }
    // If there are still waiters, keep moving forward. But don't
    // re-request next if another request has already been submitted
    // by a called waiter.
    if ( skipped > 0 && skipped == this.waiters.length ) {
        this.next();
    }
    else if ( VIEWER && VIEWER.listing && this === VIEWER.listing &&
              VIEWER.isOutdated() )
        // Viewer has out-of-date view of this listing
        VIEWER.placeholderActivate();
};

// Helper function to load data for the listing
Listing.prototype.load = function(url, callback) {
    if ( this.req ) {
        // FIXME: Don't abort req if resubmitting same url (FIXME: callback)
        this.req.abort();
        this.req = null;
    }
    var that = this;
    var _check_req = function() {
        // Only proceed if this request is our currently pending request
        if ( typeof that.req === 'undefined' || req !== that.req ) {
            req.abort();
            return false;
        }
        return true;
    };

    //console.log('REQ');console.trace();
    var req = new XMLHttpRequest();
    req.addEventListener('load', function(e) {
        if ( !_check_req() ) return;
        that.req = null;
        return callback(JSON.parse(req.responseText));
    });
    req.addEventListener('error', function(e) {
        if ( !_check_req() ) return;
        console.log("XMLHttpRequest got an error, status=" + that.req.status);
        var error = that.req.status ? "HTTP " + that.req.status :
            "Unknown error";
        that.req = null;
        return callback({'error': "RPC error: " + error});
    });
    req.open('GET', url);
    req.send();
    this.req = req;
};

// Class to encapsulate listing behavior for server-side listings
function QuasarListing(query, displayMode) {
    Listing.call(this);
    this.doneLoading = false;
    this.query = query;
    this.displayMode = displayMode;
    if ( typeof(this.query) === 'object' )
        this.query = encodeQuery(this.query);
}
QuasarListing.prototype = Object.create(Listing.prototype);

// Handler function for extension of listing to next page
QuasarListing.prototype.next = function() {
    if ( this._next() ) return;
    var that = this;
    this.load(QUASAR + '?' + this.query +
              '&start=' + this.items.length, function(obj) {
                  that._req_result(obj);
              });
};
QuasarListing.prototype._req_result = function(obj) {
    if ( !obj.error &&
         (obj.count == 0 ||
          ((obj.requested||0) > 0 && obj.count < obj.requested)) )
        // If there is no error and no items were returned, or fewer
        // items were returned than requested, we must have reached
        // the end.
        this.doneLoading = true;
    var i = this.items.length;
    this.req_error = obj.error;
    if ( !obj.error && obj.results )
        this.items = this.items.concat(obj.results);
    this._checkWaiters(true);
};

// Class to manage "Now Playing" listing
/*
function NowPlayingListing() {
    Listing.call(this);
}
NowPlayingListing.prototype = Object.create(Listing.prototype);
NowPlayingListing.prototype.next = function() { };

var NOWPLAYING = null;
quasarReady(function() {
    NOWPLAYING = NowPlayingListing();
});
*/

// Placeholder listing
function QuasarPageListing(page) {
    Listing.call(this);
    this.displayMode = 'page';
    this.items = [null];
    this.page = page;
}
QuasarPageListing.prototype = Object.create(Listing.prototype);
QuasarPageListing.next = function() {
    this.doneLoading = true;
    this._next();
}

//////////////////////////////////////////////////////////////////////
// Listing view implementation

function parseQuery(str) {
    // Extract arguments from hash
    var args = {};
    var params = str.split('&');
    for ( var i = 0; i < params.length; i++ ) {
        var j = params[i].indexOf('=');
        var k = decodeURIComponent(j < 0 ? params[i] : params[i].substr(0, j));
        if ( k ) args[k] = j < 0 ? true :
            decodeURIComponent(params[i].substr(j + 1));
    }
    return args;
}

function encodeQuery(args) {
    var keys = Object.keys(args);
    var str = '';
    for ( var i = 0; i < keys.length; i++ ) {
        var key = keys[i];
        var encKey = encodeURIComponent(key) + '=';
        var val = args[key];
        if ( typeof(val) === 'undefined' || val === null )
            continue;
        if ( typeof(val) !== 'object' )
            val = [val];
        for ( var j = 0; j < val.length; j++ ) {
            if ( str ) str += '&';
            str += encKey + encodeURIComponent(val[j]);
        }
    }
    return str;
}

function _setBreadcrumb($nav, items) {
    var $bc = $nav.find('.breadcrumb').addClass('nav-active');
    $bc.find('A:not(:first-child)').remove();
    $(items).each(function() {
        $bc.append($('<a>').attr('href', this[0]).text(this[1]));
    });
}

function quasarReady(f) {
    if ( typeof(f) === 'boolean' ) {
        this.configLoaded = true;
        quasarReady();
        return;
    }
    else if ( typeof(f) === 'undefined' ) {
        if ( this.done || loadingPlugins > 0 || !this.configLoaded )
            return;
        $(document).trigger('quasarReady');
        this.done = true;
    }
    else if ( this.done )
        f();
    else
        $(document).on('quasarReady', f);
}
quasarReady.done = false;
quasarReady.configLoaded = false;

var loadingPlugins = 0;
function loadPlugin(url) {
    var e = document.createElement('SCRIPT');
    e.src = url;
    $(e).on('load', function() {
        loadingPlugins--;
        quasarReady();
    });
    loadingPlugins++;
    document.body.appendChild(e);
}
$(document).ready(function () {
    quasarReady();
});

var HOMEITEMS = [
    {'url': '#browse=artist', 'title': "Browse artists"},
    {'url': '#browse=album', 'title': "Browse albums"},
    {'url': '#browse=directory&directory=', 'title': "Browse directories"},
];

var DEFAULTSORT = 'album,directory,tracknumber,filename';
var URLPARSERS = [

    // Search
    function (args) {
        if ( typeof(args['q']) === 'undefined' )
            return null;
        args._setNavActive = function($nav) {
            $nav.find('.nav-search').addClass('nav-active');
            $nav.find('.nav-search input[type=search]').val(args['q']);
        };
        return new QuasarListing({'any': args['q'].split(/\s+/),
                                  'sort': DEFAULTSORT});
    },

    // Browse by album
    function (args) {
        if ( (args['browse']||'') !== 'album' )
            return null;
        var bc = [['#browse=album', "Albums"]];
        args._setNavActive = function($nav) { _setBreadcrumb($nav, bc); };
        if ( typeof(args['album']) !== 'undefined' ) {
            bc[bc.length] = [args._url, args['album']||"(No album)"]
            return new QuasarListing({'mode': 'exact', 'sort': DEFAULTSORT,
                                      'directory': args['directory'],
                                      'artist': args['artist'],
                                      'album': args['album']}, 'album');
        }
        return new QuasarListing({'mode': 'exact', 'sort': DEFAULTSORT,
                                  'group': 'album,directory'},
                                 'index:album');
    },

    // Browse by artist
    function (args) {
        if ( (args['browse']||'') !== 'artist' )
            return null;
        var bc = [['#browse=artist', "Artist"]];
        args._setNavActive = function($nav) { _setBreadcrumb($nav, bc); };
        if ( typeof(args['artist']) !== 'undefined' ) {
            bc[bc.length] = [args._url, args['artist']||"(No artist)"]
            return new QuasarListing({'mode': 'exact', 'sort': DEFAULTSORT,
                                      'artist': args['artist']}, 'album');
        }
        return new QuasarListing({'mode': 'exact', 'sort': 'artist',
                                  'group': 'artist'}, 'index:artist');
    },

    // Browse by directory
    function (args) {
        if ( (args['browse']||'') !== 'directory' )
            return null;
        var bc = [[args._url, '/' + (args['directory']||'')]];
        args._setNavActive = function($nav) { _setBreadcrumb($nav, bc); };
        return new QuasarListing({'mode': 'browse',
                                  'sort': 'filename,directory',
                                  'directory': args['directory']||''},
                                 'dir');
    },
];

function getListing(req) {
    /* No change if already viewing this listing. */
    if ( VIEWER.listing && req === VIEWER.listing.quasarArgs._url )
        return null;
    /* Reuse Now Playing listing, if possible. */
    if ( PLAYER && PLAYER.listing && req === PLAYER.listing.quasarArgs._url )
        return PLAYER.listing;

    var args = parseQuery(req.substr(1));
    args._url = req ? req : '#';

    // Try each URL parser in order
    var listing = null;
    for ( var i = 0; !listing && i < URLPARSERS.length; i++ )
        listing = URLPARSERS[i](args);

    // If URL could not be parsed, use the default page
    if ( !listing ) {
        listing = new QuasarPageListing(Handlebars.templates.browseHome);
        args._setNavActive = function($nav) { _setBreadcrumb($nav, []); };
    }

    listing.quasarArgs = args;
    return listing;
}

function Viewer() {
    this.$l = $('#output');
    this.listing = null;
}

function urlForSearch(query, args) {
    return '#q=' + encodeURIComponent(query||'') + (args||'');
}

function urlForAlbum(track, args) {
    if ( !track ) return '';
    return '#browse=album&directory=' +
        /*encodeURIComponent*/(track.directory) + // URL encoding on server
        '&album=' + encodeURIComponent(track.album||'') + (args||'');
}
function urlForArtist(track, args) {
    if ( !track ) return '';
    return '#browse=artist&artist=' + encodeURIComponent(track.artist||'') +
        (args||'');
}
function urlForDirectory(track, args) {
    if ( !track ) return '';
    return '#browse=directory&directory=' +
        /*encodeURIComponent*/(track.directory||'') + // URL encoding on server
        (args||'');
}

Viewer.prototype.isOutdated = function() {
    return this.listing &&
        this.$l.find('.row').length < this.listing.items.length;
}
Viewer.prototype.placeholderActivate = function() {
    var that = this;
    var p = this.$l.find('.row').length;
    this.listing.get(p < this.listing.items.length ? p : -1,
                     function() { that.extendView(p); });
};
Viewer.prototype.placeholderEnable = function() {
    var that = this;
    var $row = $(Handlebars.templates.rowPlaceholder());
    this.$l.append($row);
    $.extend({}, $row, $row.find('A'))
        .on('click', function() { that.placeholderActivate(); return false; });
    $(document).scroll();
};

Viewer.prototype.errorEnable = function(error, retry) {
    var that = this;
    var $row = $(Handlebars.templates.rowError({
        'error': error,
        'retry': retry,
    }));
    this.$l.append($row);
    if ( !retry )
        return;
    $.extend({}, $row, $row.find('A'))
        .on('click', function() { that.placeholderActivate(); return false; });
};

/*
function makeRowGroup(l) {
    var rgl = '', rgd = '';
    for ( var i = 0; i < l.length; i++ ) {
        var s = (l[i]||'').toString();
        var c = i > 0 ? ',' : '';
        rgl += c + s.length;
        rgd += c + s;
    }
    return rgl + ';' + rgd;
}
*/

function cleanWhitespace(s) {
    return s.replace(/^\s+|\s+$/g, '').replace(/\s+/, ' ');
}

function setTooltip() {
    $(this).attr('title', cleanWhitespace($(this).text()));
}

Viewer.prototype.extendView = function(start) {
    // Remove stale items from the view
    this.$l.find('.scroll-placeholder, .row-error, .row-parent-directory')
        .remove();
    {
        var $existing = this.$l.find('.row');
        if ( start > 0 && $existing.length )
            $($existing[start-1]).nextAll().remove();
        else
            this.$l.empty();
    }

    if ( !this.listing ) {
        this.placeholderEnable();
        return -1;
    }

    // Remove empty row groups from the view
    this.$l.find('.row-group').each(function() {
        if ( $(this).find('.row').length <= 0 )
            $(this).remove();
    });
    var groupByAlbum = (this.listing.displayMode||'') === 'album';
    var $group = groupByAlbum ? this.$l.find('.row-group:last-of-type') :
        undefined;

    // Parent directory in directory browsing
    var asDirectory = (this.listing.displayMode||'') === 'dir';
    // (FIXME: Do not reference quasarArgs directly.)
    if ( asDirectory && this.listing.quasarArgs['directory'] ) {
        var parentDir = this.listing.quasarArgs['directory']
            .replace(/^(.*)(?:\/|^)[^\/]*\/*$/, "$1");
        var $row = $(Handlebars.templates.rowDirent({
            'index': -1,
            'track': null,
            'directoryUrl': urlForDirectory({'directory': parentDir}),
        }));
        this.$l.prepend($row);
    }

    var asIndex = (this.listing.displayMode||'').substr(0, 6) === 'index:' ?
        this.listing.displayMode.substr(6) : false;
    var asPage = (this.listing.displayMode||'') == 'page';

    // Create new rows for items in the Listing
    var items = this.listing.items;
    for ( var i = start; i < items.length; i++ ) {
        var track = items[i];
        var albumUrl = urlForAlbum(track);
        var $row;

        if ( asPage ) {
            $row = $(this.listing.page({'homeItems': HOMEITEMS}));
            var branding = getBranding(true);
            $row.find('.page-branding').empty().append(branding[0]);
            if ( !branding[2] )
                $row.addClass('page-hideLogo');
            else if ( branding[2] !== true )
                $row.find('.rowCover').attr('src', branding[2]);
        }
        else if ( asDirectory )
            $row = $(Handlebars.templates.rowDirent({
                'index': i,
                'track': track,
                'subdir': track.directory.replace(/^.*\//, ''),
                'directoryUrl': urlForDirectory(track),
            }));
        else if ( asIndex )
            $row = $(Handlebars.templates.rowIndex({
                'index': i,
                'track': track,
                'indexTypeAlbum': asIndex === 'album',
                'indexTypeArtist': asIndex === 'artist',
                'albumUrl': albumUrl,
                'artistUrl': urlForArtist(track),
            }));
        else
            $row = $(Handlebars.templates.row({
                'index': i,
                'track': track,
                'albumUrl': albumUrl,
                'artistUrl': urlForArtist(track),
                'group': groupByAlbum,
            }));

        // Set title attributes (tooltips) to row content
        $row.find('SPAN:not(.row-flag)').each(setTooltip);

        // Enable click-to-play
        $row.find('A.row-play').click(function (e) {
            try {
                var $row = $(e.target).closest('LI');
                var index = $row.attr('data-quasar-listing-index')
                //NOWPLAYING.clearPlaylist();
                //NOWPLAYING.addTrack(track);
                PLAYER.setListing(VIEWER.listing, index);
            }
            catch(e) {console.exception(e);}
            return false;
        });

        if ( groupByAlbum ) {
            // Check if we need to create a new row group
            if ( !$group ||
                 albumUrl !== $group.attr('data-quasar-listing-group') ) {
                $group = $(Handlebars.templates.rowGroup({
                    'track': track,
                    'rowGroup': albumUrl,
                    'albumUrl': albumUrl,
                }));
                $group.find('H2').each(setTooltip);
                this.$l.append($group);
            }
            $group.find('.rows').append($row);
        }
        else
            this.$l.append($row);
    }
    var rc = i - start;

    // Don't lose track of the current track if the player has gotten
    // ahead of us. Check for a missing row-nowplaying item to ensure
    // it does not interfere with scrolling.
    if ( PLAYER && PLAYER.listing === this.listing &&
         !this.$l.find('.row-nowplaying').length ) {
        this.updateNowPlaying(PLAYER);
    }

    // Insert an error message if we encountered an error
    if ( this.listing.req_error )
        this.errorEnable("Error loading more items: " + this.listing.req_error,
                         true);
    // Insert an error message if we have no results at all
    else if ( rc == 0 && start == 0 && this.listing.doneLoading )
        this.errorEnable("There are no results to display.", false);
    // Insert placeholder if we expect more rows may be available
    else if ( /* rc > 0 */ !this.listing.doneLoading ) {
        if ( !this.listing.doneLoading )
            this.placeholderEnable();
    }

    return rc;
};

Viewer.prototype.updateNavigation = function() {
    $('.nav .nav-active').removeClass('nav-active');
    if ( PLAYER ) {
        $('.nav .nav-nowplaying A')
            .attr('href',
                  PLAYER.listing ? PLAYER.listing.quasarArgs._url : '#');
        if ( this.listing === PLAYER.listing ) {
            $('.nav .nav-nowplaying').addClass('nav-active');
            this.updateNowPlaying(PLAYER);
        }
    }
    if ( !this.listing || !this.listing.quasarArgs )
        return;

    var args = this.listing.quasarArgs;
    if ( location.hash === '' )
        location.replace(args._url); // Avoid auto-redirect history entry
    else
        location.hash = args._url;
    if ( args._setNavActive )
        args._setNavActive($('.nav'));
};

Viewer.prototype.setListing = function(listing) {
    $('.nav-toggle').prop('checked', false);
    $('.nav-search input').blur();
    if ( !listing )
        return;
    this.listing = listing;
    this.extendView(0);
    $(document).scrollTop(0);
    this.updateNavigation();
};

// Highlight the row of the currently-playing track, if applicable
Viewer.prototype.updateNowPlaying = function(player) {
    var $rows = this.$l.find('.row');
    $rows.removeClass('row-nowplaying');
    if ( player.listing !== this.listing )
        return;
    function scrollToRow(e) {
        // Scroll the least amount needed for the given row to be visible
        var $e = $(e), marginTop = $('HEADER').outerHeight();
        var scrollMin = $e.offset().top - marginTop;
        var scrollMax = $e.offset().top  + $e.outerHeight() - $(window).height();
        var scrollPos = $(document).scrollTop();
        var scrollTo = -1;
        //console.log([scrollMin, scrollPos, scrollMax]);
        if ( scrollPos > scrollMin && scrollPos < scrollMax ) return;
        if ( scrollPos > scrollMin ) scrollTo = scrollMin;
        else if ( scrollPos < scrollMax ) scrollTo = scrollMax;
        //console.log("Scroll to " + scrollTo);
        if ( scrollTo >= 0 ) $(document).scrollTop(scrollTo);
    }
    if ( player.listingPos >= 0 && player.listingPos < $rows.length ) {
        var $row = $($rows[player.listingPos]).addClass('row-nowplaying');
        if ( $row.length ) scrollToRow($row[0]);
    }
};

Handlebars.registerHelper('trackPath', trackPath); // FIXME
Handlebars.registerHelper('decodeURIComponent', function(s) {
    try { return decodeURIComponent(s); }
    catch(e) { return unescape(s); } // Non-Unicode-aware version
}); // FIXME

function getBranding(useLong) {
    if ( !BRANDING )
        return [$('.nav-logo LABEL > *'), document.title, true]
    var orig_branding = useLong && typeof(LONG_BRANDING) !== 'undefined' ?
        LONG_BRANDING : BRANDING;
    var $branding = $(orig_branding);
    if ( !$branding.length )
        $branding = $('<span>' + orig_branding + '</span>');
    var branding_text =
        (typeof(BRANDING_TEXT) === 'undefined' ? '' : BRANDING_TEXT) ||
        $branding.text() || $branding.attr('alt') || $branding.attr('title');
    var branding_logo =
        (typeof(BRANDING_LOGO) === 'undefined' ? true : BRANDING_LOGO);
    return [$branding, branding_text, branding_logo];
}
quasarReady(function() {
    {
        /* Apply branding */
        var branding = getBranding(false);
        $('.nav-logo > LABEL').empty().append(branding[0]);
        document.title = branding[1];
    }
    $(window).resize();
});
$(window).resize(function() {
    var isCollapsed = $(window).width() <= 799;
    var $nav = $('UL.nav'), $navSearch = $nav.find('LI.nav-search');
    $navSearch.css('max-width', $nav.width() - (
        $nav.find('LI.nav-icon').outerWidth(true) +
            $nav.find('LI.nav-logo').outerWidth(true) +
            ($navSearch.outerWidth(true) - $navSearch.width())
    ) + 'px');
    var $navBreadcrumb = $nav.find('LI.breadcrumb');
    $navBreadcrumb.css('max-width', $nav.width() - 16 - (
        (isCollapsed ? $nav.find('LI.nav-icon').outerWidth(true) :
         ($nav.find('LI.nav-nowplaying').outerWidth(true) +
          $nav.find('LI.nav-search').outerWidth(true))) +
            $nav.find('LI.nav-logo').outerWidth(true) +
            ($navBreadcrumb.outerWidth(true) - $navBreadcrumb.width())
    ) + 'px');
    $('#body').css('margin-top', $('HEADER').outerHeight() + 'px');
    $(document).scroll();
});
var VIEWER = null;
var STATE = {};
quasarReady(function () {
    VIEWER = new Viewer();
    $(window).trigger('hashchange');
});
$(document).scroll(function() {
    // Don't autorequest if request already in progress
    if ( !VIEWER || !VIEWER.listing || VIEWER.listing.req ) return true;
    function isPlaceholderInView(e) {
        var $e = $(e), pos = $e.offset().top - $(document).scrollTop();
        return pos >= -$e.outerHeight() && pos < $(window).height();
    }
    if ( jQuery.grep($('.scroll-placeholder'), isPlaceholderInView).length > 0 )
        VIEWER.placeholderActivate();
    return true;
});
$(window).on('hashchange', function () {
    if ( !VIEWER ) return true;
    var listing = getListing(location.hash);
    if ( listing )
        VIEWER.setListing(listing);
});
$('.form-search').on('submit', function() {
    location.hash = urlForSearch($(this).find('input[type=search]').val());
    return false;
});

//////////////////////////////////////////////////////////////////////
// Music player component

function QuasarPlayer(el) {
    // Player objects
    this.players = [];
    // Playlist
    this.playlist = [];
    this.plpos = 0;
    // Interface initialization
    this.$el = $(el);
    this.uiTimer = null;
    this.baseTitle = document.title;
    this.listing = null;
    this.listingPos = -1;
    this._repeatMode = 0;
    this._initUI();
    // For notifications
    this._notification = null;
    this._notificationTimer = null;
}

// User interface
QuasarPlayer.prototype._initUI = function() {
    // Initialize player interface
    this.$el.addClass('playStatus');
    this.$el.append($(Handlebars.templates.player()));
    var that = this;

    // Check support for INPUT[type='range']
    {
        var e = document.createElement('input');
        e.setAttribute('type', 'range');
        if ( e.type !== 'range' ) {
            console.log('range elements not supported, revert to ' + e.type);
            this.$el.find('input[type=\'range\']').remove();
        }
    }
    // Resize range control to fit window width
    $(window).resize(function() {
        var w = that.$el.find('.playerControls').width() - 18 -
            that.$el.find('.playerControls > .playerControls-left, ' +
                          '.playerControls > .playerControls-right')
            .outerWidth(true);
        if ( w < 0 ) w = 0;
        that.$el.find('.playerControls > .playerControl-range').width(w);
    });

    // Button event handlers
    this.$el.find('.playerControl-toggle').click(function() {
        that.toggle();
    });
    this.$el.find('.playerControl-next').click(function() {
        that.trackNext();
    });
    this.$el.find('.playerControl-prev').click(function() {
        that.trackPrevOrSeek();
    });
    this.$el.find('.playerControl-range').change(function() {
        that.seekTo($(this).val())
    });

    $(window).resize();       // Also trigger body top margin adjustment
    this.updateMetadata(null);
};

function formatTime(sec) {
    sec = Math.floor(sec);
    var min = Math.floor(sec/60);
    sec = sec % 60;
    var hour = Math.floor(min/60);
    min = min % 60;
    function _dd(num) {
        num = num.toString();
        while ( num.length < 2 )
            num = '0' + num;
        return num;
    }
    return (hour > 0 ? _dd(hour) + ':' + _dd(min) : min.toString()) +
        ':' + _dd(sec);
}

function trackPath(track, key) {
    if ( !track )
        return null;
    var escapedDir = (track.directory ? track.directory + '/' : '');
    // Directory and file names pre-escaped on server
    // .replace(/([^\/]+)/g, function (s) { return encodeURIComponent(s) });
    var trackpath = (MUSICDIR ? MUSICDIR + '/' : '') + escapedDir;
    return track[key] ? (trackpath + track[key]) : track[key];
}

QuasarPlayer.prototype._updateStatus = function() {
    // Renew timer
    if ( this.uiTimer !== null ) {
        clearTimeout(this.uiTimer);
        this.uiTimer = null;
    }
    var that = this;

    // Playing status
    var isPlaying = this.isPlaying();
    if ( isPlaying )
        this.$el.addClass('player-playing');
    else
        this.$el.removeClass('player-playing');

    // Current time / duration
    var $posText = this.$el.find('.playerControl-time'),
        $posRange = this.$el.find('.playerControl-range');
    if ( this.players.length > 0 && this.listingPos >= 0 ) {
        var pos = this.getTime(), dur = this.getDuration();
        if ( this.players[0].readyState < 2 )
            $posText.text('Buffering...');
        else
            $posText.text(formatTime(pos) +
                          (dur >= 0 ? (' / ' + formatTime(dur)) : ''));
        if ( dur >= 0 && this.players[0].seekable ) {
            $posRange.attr('max', dur).val(pos)
                .attr('disabled', false).show();
        }
        else
            $posRange.val(0).attr('disabled', true).hide();
    }
    else {
        $posText.text('');
        $posRange.val(0).attr('disabled', true).hide();
    }


    // Page title
    var titleMetadata = cleanWhitespace($('.playerMetaPageTitle').text());
    document.title = (isPlaying ? '\u25b6 ' : '') +
        (titleMetadata ? (titleMetadata + ' - ') : '') +
        this.baseTitle;
};
QuasarPlayer.prototype.updateMetadata = function(track) {
    var cover = trackPath(track, 'cover');
    $('.playerCover IMG').attr('src', cover ? cover : '');
    this.$el.find('.playerMetadata').empty()
        .append($(Handlebars.templates.playerMetadata({
            'track': track,
            'albumUrl': urlForAlbum(track),
            'artistUrl': urlForArtist(track),
        })));
    this._updateStatus();
    if ( track )
        this._notifyTrack();
    VIEWER.updateNowPlaying(this);
};

// HTML5 player management
QuasarPlayer.prototype._preloadPlayer = function(url) {
    // HTML5 player manager. Only supports two players (foreground
    // player and background player for preloading)
    while ( this.players.length < 2 ) {
        var p = document.createElement('AUDIO');
        this.players[this.players.length] = p;
        var that = this;
        $(p).on('ended', function() {
            //// Recycle this player
            //that.players.push(that.players.shift());
        }).on('pause', function() {
            that._updateStatus();
        }).on('play', function() {
            that._updateStatus();
        }).on('durationchange', function() {
            that._updateStatus();
        }).on('timeupdate', function() {
            that._updateStatus();
            that._checkPreload();
        }).on('ended', function() {
            if ( that.repeatMode() == 1 )
                that.play();
            else
                that.trackNext();
        }).attr('preload', 'auto');
        $(document.body).append(p);
        // WebKit: Media elements can only start playing in response
        // to a user gesture, so make this element eligible while we
        // have the opportunity.
        p.play();
        p.pause();
    }
    // Check for player that has loaded this URL already
    for ( var i = 0; i < this.players.length; i++ ) {
        var src = $(this.players[i]).attr('src');
        if ( src === url )
            return this.players[i];
    }
    // Otherwise, use background player
    p = this.players[1];
    $(p).attr('src', url);
    return p;
};
QuasarPlayer.prototype._activatePlayer = function(player) {
    for ( var i = 0; i < this.players.length && this.players[0] !== player;
          i++ ) {
        this.players[0].pause();
        this.players.push(this.players.shift());
    }
    player.currentTime = 0;
    player.play();
};
QuasarPlayer.prototype._checkPreload = function() {
    if ( this.preloadedNext || this.listingPos < 0 )
        return;
    var dur = this.getDuration(), t = this.getTime();
    if ( !dur || !t )
        return;
    if ( dur-t < 30 && (dur > 60 || t > dur/2) ) {
        var that = this;
        this.preloadedNext = true;
        // Find the next track and preload it
        this.listing.get(this.listingPos + 1, function(track) {
            if ( !that.preloadedNext )
                return;
            var url = trackPath(track, 'filename')
            //console.log("Preloading " + url);
            that._preloadPlayer(url);
        });
    }
}

QuasarPlayer.prototype._notifyTrack = function() {
    if ( true )                 // Disabled for now
        return;
    if ( !("Notification" in window) || Notification.permission === 'denied' )
        return;
    var message = $('.playerMetaPageTitle').text()
        .replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    if ( !message )
        return;
    var that = this;
    if ( Notification.permission !== "granted" ) {
        // We need to ask the user for permission
        Notification.requestPermission(function (permission) {
            // If the user accepts, let's create a notification
            if (permission === "granted")
                that._notifyTrack();
        });
    }
    else {
        // If it's okay let's create a notification
        this._notification = new Notification(
            "Now Playing", {
                "body": message,
                "silent": true, "noscreen": true, "renotify": true,
                "tag": "quasarNowPlaying",
            });
        if ( this._notification_timeout )
            clearTimeout(this._notification_timeout);
        this._notification_timeout = setTimeout(function () {
            that._notification.close();
        }, 3000);
    }
};

// API to control playback
QuasarPlayer.prototype.isPlaying = function() {
    return this.players.length > 0 && !this.players[0].paused;
};
QuasarPlayer.prototype.play = function() {
    if ( !this.players.length || this.listingPos < 0 ) {
        if ( VIEWER.listing && VIEWER.listing.items.length &&
             (VIEWER.listing.displayMode||'').substr(0, 6) !== 'index:' )
            this.setListing(VIEWER.listing, 0);
        return;
    }
    this.players[0].play();
};

QuasarPlayer.prototype.pause = function() {
    if ( !this.players.length ) return;
    this.players[0].pause();
};

QuasarPlayer.prototype.toggle = function() {
    return this.isPlaying() ? this.pause() : this.play();
};
QuasarPlayer.prototype.playNoStart = function() {
    if ( this.players.length && this.listingPos >= 0 )
        this.play();
};
QuasarPlayer.prototype.toggleNoStart = function() {
    return this.isPlaying() ? this.pause() : this.playNoStart();
};

QuasarPlayer.prototype.getTime = function() {
    if ( this.players.length <= 0 || this.listingPos < 0 )
        return null;
    return this.players[0].currentTime;
};

QuasarPlayer.prototype.getDuration = function() {
    if ( this.players.length <= 0 || this.listingPos < 0 )
        return null;
    var dur = this.players[0].duration;
    if ( isFinite(dur) )
        return dur;
    return -1;
};

QuasarPlayer.prototype.seekTo = function(t) {
    if ( this.players.length <= 0 )
        return;
    this.players[0].currentTime = t;
};

QuasarPlayer.prototype.seekBy = function(t) {
    if ( this.players.length <= 0 )
        return;
    t += this.players[0].currentTime;
    if ( t < 0 ) t = 0;
    var dur = this.getDuration();
    if ( dur >= 0 && t > dur ) t = dur;
    this.seekTo(t);
};

QuasarPlayer.prototype.seekToFraction = function(t) {
    if ( this.players.length <= 0 )
        return;
    var dur = this.getDuration();
    if ( dur < 0 ) return;
    if ( t < 0 ) t = 0;
    if ( t > 1 ) t = 1;
    this.seekTo(t * dur);
};

QuasarPlayer.prototype.trackGo = function(n) {
    if ( !this.listing ) return;
    if ( n < 0 ) return;
    var that = this;
    n = parseInt(n);
    this.listing.get(n, function(track) {
        that.preloadedNext = false;
        if ( track ) {
            if ( track.filename ) {
                var player = that._preloadPlayer(trackPath(track, 'filename'));
                that.listingPos = n;
                that._activatePlayer(player);
                that.updateMetadata(track);
            }
            else {
                // Oops, a subdirectory. Sorted to the beginning, so
                // skip to the next track.
                that.trackGo(n+1);
            }
        }
        else if ( n >= that.listing.items.length ) {
            // End of playlist
            if ( that.repeatMode() && that.listing.items.length > 0 && n > 0 )
                that.trackGo(0);
            else {
                that.listingPos = -1;
                that.updateMetadata(track);
            }
        }
    });
};

QuasarPlayer.prototype.trackDelta = function(d) {
    if ( this.listingPos < 0 )
        return;
    this.trackGo(this.listingPos + d);
};

QuasarPlayer.prototype.trackNext = function() {
    this.trackDelta(1);
};

QuasarPlayer.prototype.trackPrev = function() {
    this.trackDelta(-1);
}

QuasarPlayer.prototype.trackPrevOrSeek = function() {
    var t = this.getTime();
    if ( t === null || t < 3 )
        this.trackDelta(-1);
    else
        this.seekTo(0);
};

QuasarPlayer.prototype.repeatMode = function(newval) {
    if ( typeof newval !== 'undefined' )
        this._repeatMode = newval % 3;
    return this._repeatMode;
};
/*
QuasarPlayer.prototype.shuffleMode = function(newval) {
    return 0;
};
QuasarPlayer.prototype.consumeMode = function(newval) {
    return 0;
};
*/

QuasarPlayer.prototype.setListing = function(listing, pos) {
    if ( typeof(pos) === 'undefined' )
        pos = -1;
    this.listing = listing;
    this.trackGo(pos);
    VIEWER.updateNavigation();
};

// Instantiation of global player
var PLAYER = null;
quasarReady(function() {
    PLAYER = new QuasarPlayer($('#player'));
});

// Keyboard shortcuts
$(document).on('keydown', function(e) {
    // Key definitions based on Windows VKs http://cherrytree.at/misc/vk.htm
    var key = e.which;
    var mod = e.shiftKey;
    var modIgnore = e.ctrlKey || e.altKey || e.metaKey;

    // Active element, so we can detect possible conflicts
    var ae = document.activeElement;
    var aet = ae ? ae.tagName.toUpperCase() : '';
    var aety = aet === 'INPUT' ? ae.type.toLowerCase() : '';

    // Media keys
    if ( key == 176 )             // VK_MEDIA_NEXT_TRACK (Chrome)
        PLAYER.trackNext();       //   => Next track
    else if ( key == 177 )        // VK_MEDIA_PREV_TRACK (Chrome)
        PLAYER.trackPrevOrSeek(); //   => Previous track
    else if ( key == 178 )        // VK_MEDIA_STOP (Chrome)
        PLAYER.pause();           //  => Pause
    else if ( key == 179 )        // VK_MEDIA_PLAY_PAUSE (Chrome)
        PLAYER.toggle();          //   => Toggle play/pause

    else if ( key == 27 ) {     // Escape
        ae.blur();
        $('#nav-toggle').prop('checked', false);
        return true;
    }

    // Most keybindings conflict with input controls. These ones are
    // compatible with buttons and range controls.
    else if ( aety && aety !== 'range' )
        return true;
    else if ( modIgnore ) // && (key == 37 || key == 39) )
        // Conflicts with system shortcuts (including history navigation)
        return true;

    // Playback control
    else if ( !mod && key == 32 )    // Spacebar
        PLAYER.toggleNoStart();      //   => Toggle play/pause (never start)
    else if ( !mod && key == 88 )    // "X" key
        PLAYER.toggle();             //   => Toggle play/pause
    else if ( (!mod && key == 67) || // "C" key
              ( mod && key == 39) )  // Shift + Right arrow
        PLAYER.trackNext();          //   => Next track
    else if ( (!mod && key == 90) || // "Z" key
              ( mod && key == 37) )  // Shift + Left arrow
        PLAYER.trackPrevOrSeek();    //   => Previous track (or seek to 0)

    // Seeking
    else if ( !mod && key >= 48 && key <= 57 ) // 0, 1, ..., 9
        PLAYER.seekToFraction((key-48)/10.);   //   => Seek to percentage
    else if ( !mod && key == 190 ) // "." key => Seek + 5 seconds
         PLAYER.seekBy(+ 5);
    else if ( !mod && key == 188 ) // "," key => Seek - 5 seconds
         PLAYER.seekBy(- 5);
    else if ( !mod && key == 222 ) // "'" key => Seek +10 seconds
         PLAYER.seekBy(+10);
    else if ( !mod && key ==  59 ) // ";" key => Seek -10 seconds
         PLAYER.seekBy(-10);
    else if ( !mod && key == 221 ) // "]" key => Seek +30 seconds
         PLAYER.seekBy(+30);
    else if ( !mod && key == 219 ) // "[" key => Seek -30 seconds
         PLAYER.seekBy(-30);

    // Navigation keybindings
    else if ( mod && key == 65 )                     // Shift+A (artist)
        $('#player .playerMetaArtist A')[0].click(); //   => To current artist
    else if ( mod && key == 66 )                     // Shift+B (browse)
        $('.nav .breadcrumb A')[0].click();          //   => To browse
    else if ( mod && key == 68 )                     // Shift+D (disc)
        $('#player .playerMetaAlbum A')[0].click();  //   => To current album
    else if ( mod && key == 78 )                     // Shift+N (Now Playing)
        $('.nav-nowplaying A')[0].click();           //   => To Now Playing
    else if ( !mod && key == 191 ) {                 // "/" key
        $('#nav-toggle').prop('checked', true);      //   => Focus search
        $('.nav-search INPUT').focus().select();
    }

    else if ( aet == 'INPUT' || aet === 'BUTTON' )
        return true;

    // Additional keybindings
    else if ( key == 39 )       // Right arrow
        PLAYER.seekBy(5);       //   => Seek +5 seconds
    else if ( key == 37 )       // Left arrow
        PLAYER.seekBy(-5);      //   => Seek -5 seconds
    else
        return true;
    return false;

    // Choices:
    // * [Z][X][C] Previous/Pause/Next (near Winamp, but different),
    //   [Space] Play/Pause, [S-Left][S-Right] Previous/Next
    // % Seek: [1] - [0] to percentage, [,][.][;]['][[][]] by 5/10/30 seconds,
    //   [Left][Right] by 5 seconds
    // $ Navigation: [/] to search, [S-N]ow Playing, [S-B]rowse,
    //               current [S-A]rtist or [S-D]isc(album)
    //
    // $ FUTURE: Navigation: [S-P]Playlists
    // ^ FUTURE: [R]epeat, [S]huffle, [M]ute. Volume: [Up][Down], [-][+=]
    // @ Reserved: [G] for advanced navigation, [H][L] for Vim, [?] for help
    // # Viewer: [J][K] to scroll, [O] to play, [P] Enqueue (add to playList),
    //           [A][D] go to artist/album,
    //           [Up][Down] scroll, [Ret] enqueue (play for now), [S-Ret] play
    // Sadly, [J][K][L] conflicts with Viewer scrolling
    //
    // ` % % % % % % % % % % - = <x]     ~ 1 2 3 4 5 6 7 8 9 0 _ + <x]
    // >| q w e ^ t y u i # # % % \      >| Q W E R T Y U I O $ { } |
    // ___ # ^ # f @ @ # # @ % % ###     ___ $ S $ F G H J K L : " ###
    // ____ * * * v b n ^ % % $ ____     &&&& Z X C V $ $ M < > @ &&&&
});
$(document).on('keyup', function(e) {
    if ( e.shiftKey || e.ctrlKey || e.altKey || e.metaKey )
        return true;

    var ae = document.activeElement;
    var aet = ae ? ae.tagName.toUpperCase() : '';
    var aety = aet === 'INPUT' ? ae.type.toLowerCase() : '';

    // Spacebar should not trigger buttons
    if ( aet == 'BUTTON' && e.which == 32 ) return false;
    return true;
});
