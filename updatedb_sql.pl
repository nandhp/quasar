#!/usr/bin/perl

=head1 NAME

quasar_updatedb - Scan filesystem and create Quasar database

=head1 SYNOPSIS

quasar_updatedb [--exclude=PATH] DBFILE DIRECTORY

=head1 OPTIONS

=over 8

=item B<--exclude>=PATH

Exclude PATH from the database. If PATH begins with a slash it is
anchored to the root of the search tree; otherwise, it will apply in
any subdirectory.

=item B<--collapse-whitespace>

Normalize the whitespace in the media tags to single spaces with no
leading/trailing whitespace. (Filenames and directories excepted.)

=item B<--collapse-case>

Configure the database to do case-insensitive comparison of media
tags. (Filenames and directories excepted.)

=back

=cut

use Getopt::Long;
use Pod::Usage;

use Image::ExifTool;
use Encode;
use DBI;
use File::Spec;
use File::Find;

use warnings;
use strict;

# Parse command-line arguments
my @exclude = ();
sub push_exclude {
    my ($cb, $dir) = @_;
    my $anchor = 0;
    $dir =~ s/^\/+// and $anchor = 1;
    $dir =~ s/\/*$//;
    $dir =~ s/\/\/+/\//g;
    $dir = ($anchor ? '^/*' : '(^|/)') . quotemeta($dir) . '($|/)';
    push @exclude, qr/$dir/;
}

my $collapse_whitespace = 0;
my $collapse_case = 0;

GetOptions('exclude=s' => \&push_exclude,
           'collapse-whitespace' => \$collapse_whitespace,
           'collapse-case' => \$collapse_case,
           'help|?' => sub {pod2usage(1)}) or pod2usage(2);

my $dbfile = shift(@ARGV) or pod2usage("Missing parameter: DBFILE");
my $dir = shift(@ARGV) or pod2usage("Missing parameter: DIRECTORY");

# Open database file
my $dbh = DBI->connect('dbi:SQLite:dbname=' . $dbfile, '', '', {
    sqlite_unicode => 1,
});

# Initialize database
$dbh->do('PRAGMA encoding = "UTF-8";');
$dbh->do('PRAGMA foreign_keys = ON;');
$dbh->do('BEGIN TRANSACTION;');
my %tables = (
    track => [                  # PRIMARY KEY albumid, filename
        ['albumid', 'INTEGER NOT NULL'],
        ['filename', 'TEXT NOT NULL'],
        ['title', 'TEXT'],
        ['artistid', 'INTEGER'],
        ['tracknumber', 'INTEGER'],
        ['tracktotal', 'INTEGER'], # Usually an album property; not guaranteed
        ['discnumber', 'INTEGER'],
        ['disctotal', 'INTEGER'], # Also usually an album property
        ['year', 'INTEGER'],
        ['genreid', 'INTEGER'],
        ['duration', 'INTEGER NOT NULL'],
    ],
    # The 'album' table represents directory + album combinations.
    # This allows "Greatest Hits" albums to be treated as distinct.
    album => [                  # UNIQUE directory, album
        ['albumid', 'INTEGER NOT NULL PRIMARY KEY'],
        ['directory', 'TEXT NOT NULL'],
        ['album', 'TEXT'],
        ['cover', 'TEXT'],
    ],
    # Frequently repeated strings
    artist => [
        ['artistid', 'INTEGER NOT NULL PRIMARY KEY'],
        ['artist', 'TEXT UNIQUE NOT NULL']
    ],
    genre => [
        ['genreid', 'INTEGER NOT NULL PRIMARY KEY'],
        ['genre', 'TEXT UNIQUE']
    ],
);
if ( $collapse_whitespace ) {
    foreach my $a ( values %tables ) {
        foreach my $c ( @$a ) {
            $c->[1] .= ' COLLATE NOCASE'
                if $c->[1] =~ /^TEXT/i and $c->[0] ne 'directory';
        }
    }
}
my %constraints = (
    track => ['PRIMARY KEY (albumid, filename)',
              'FOREIGN KEY (albumid) REFERENCES album(albumid)',
              'FOREIGN KEY (artistid) REFERENCES artist(artistid)',
              'FOREIGN KEY (genreid) REFERENCES genre(genreid)',
    ],
    album => ['UNIQUE (directory, album)'],
);
my %queries = ();
foreach my $table ( 'track', (grep { $_ ne 'track' } keys %tables) ) {
    $dbh->do("DROP TABLE IF EXISTS $table;") or die;
}
foreach my $table ( (grep { $_ ne 'track' } keys %tables), 'track' ) {
    my $cols = $tables{$table} or die;
    my ($idcol, $namecol) = ($table . 'id', $table);
    my $colspec = join(', ', map {"$_->[0] $_->[1]"} @$cols);
    my @datacols = grep { $_->[0] ne $idcol } @$cols;
    my $colnames = join(', ', map { $_->[0] } @datacols);
    my $colvals = join(', ', map { '?' . ($_+1) } 0..$#datacols);
    $dbh->do("CREATE TABLE $table($colspec" .
             (exists($constraints{$table}) ?
              join(', ', '', @{$constraints{$table}}) : '') .
             ');') or die;
    if ( $table eq 'track' ) {
        $queries{$table} = [$dbh->prepare("INSERT OR REPLACE INTO $table " .
                                          "($colnames) VALUES ($colvals);"),
                            undef];
        $queries{$table}[0] or die;
    }
    else {
        my $where = $table eq 'track' ? 'albumid = ?1 AND filename = ?2' :
            $table eq 'album' ? "directory = ?1 AND ((?2 IS NULL AND $namecol IS NULL) OR (?2 NOT NULL AND $namecol = ?2))" :
            "$namecol = ?1";
        $queries{$table} = [
            $dbh->prepare(
                "INSERT OR REPLACE INTO $table ($idcol, $colnames) VALUES (" .
                "(SELECT $idcol FROM $table WHERE $where), $colvals);"),
            $dbh->prepare("SELECT $idcol FROM $table WHERE $where;")];
        ($queries{$table}[0] and $queries{$table}[1]) or die;
    }
}

sub lookup_row {                # terrible name
    my $table = shift @_;
    #$queries{$table}[0]->execute(@_);
    for ( my $i = 0; $i < @_; $i++ ) {
        if ( $tables{$table}[$i+($table eq 'track' ? 0 : 1)][0] =~ /^(directory|filename|cover)$/ ) {
            $queries{$table}[0]->bind_param($i+1, $_[$i], DBI::SQL_BLOB);
        }
        else {
            $queries{$table}[0]->bind_param($i+1, $_[$i]);
        }
    }
    $queries{$table}[0]->execute();
    my $q = $queries{$table}[1];
    return undef if !$q;
    if ( $table eq 'album' ) {
        $q->bind_param(1, $_[0], DBI::SQL_BLOB); # directory
        $q->bind_param(2, $_[1]);                # album
    }
    else {
        $q->bind_param(1, $_[0]);
    }
    $q->execute();
    my $row = $q->fetch();
    die "ID lookup failed after insert for $table" unless $row;
    return $row->[0];
}

sub get_tag {
    my $info = shift @_;
    my $tag = shift @_;
    my $v = $info->GetValue($tag, @_);
    $v = $info->GetValue("$tag (1)", @_) if !$v;
    $v = decode_utf8($v, Encode::FB_WARN);
    if ( $collapse_whitespace && $v ) {
        $v =~ s/\s+/ /g;
        $v =~ s/^\s+|\s+$//g;
    }
    return $v;
}

my $lastcoverdir = undef;
my $lastcover = undef;
sub find_cover {
    my ($dir) = @_;
    # FIXME: just look it up
    return $lastcover if defined($lastcoverdir) and $lastcoverdir eq $dir;
    die unless -d $dir;

    # From Yocto:
    opendir DIR, $dir;
    my @f = sort grep { m/(cover|folder|albumart)\.(jpe?g?|png|gif|svg)/i and
                            -f "$dir/$_" } readdir DIR;
    closedir DIR;
    ($lastcoverdir, $lastcover) = ($dir, $f[0]);
    return @f ? $f[0] : undef;
}

sub preprocess {
    return sort { (((-f "$File::Find::name/$b")||0) <=>
                   ((-f "$File::Find::name/$a")||0)) || (lc $a cmp lc $b) } @_;
}

my $count = 0;
sub wanted {
    return $File::Find::prune = 1 if 0 && $count > 100;
    my $f = $File::Find::name;
    if ( $_ eq '__MACOSX' or ($_ ne '.' and $_ =~ /^\./) or
         grep { $f =~ /$_/ } @exclude ) {
        $File::Find::prune = 1;
        return;
    }
    return unless -f $f and -r $f;
    return unless $f =~ /\.(mp3|m4a|aac|flac|ogg)$/;

    my @fnsplit = File::Spec->splitpath($f);
    $fnsplit[0] and die "Unexpected volume name '$fnsplit[0]' for '$f'";
    my $fndir = $fnsplit[1];
    $fnsplit[1] = File::Spec->abs2rel($fnsplit[1], $dir);
    $fnsplit[1] = '' if $fnsplit[1] eq '.';
    $fnsplit[1] =~ /(\/|^)\.(\/|$)/ and die "Awkward relative directory: '$fnsplit[1]' for '$f'";
    my %obj = (
        # URL-encode all filenames
        'directory' => $fnsplit[1],
        'filename' => $fnsplit[2],
        'cover' => find_cover($fndir),
    );
    # Lookup ID tags
    my $info = new Image::ExifTool();
    if ( $info->ExtractInfo($f) ) {
        my ($track, $ntracks) = (get_tag($info, 'Track') ||
                                 get_tag($info, 'TrackNumber') ||
                                 '') =~ /^0*(\d+?)(?:\s*(?:\/|of)\s*0*(\d+?))?$/;
        my ($disc, $ndiscs) = (get_tag($info, 'PartOfSet') ||
                               get_tag($info, 'Disc') ||
                               get_tag($info, 'DiscNumber') ||
                               '') =~ /^0*(\d+?)(?:\s*(?:\/|of)\s*0*(\d+?))?$/;
        my $year = get_tag($info, 'Year');
        $_ = (defined($_) && $_ =~ /^\s*(\d+)\s*$/) ? int($1) : undef
            foreach $track, $ntracks, $year;
        my $dur = int(get_tag($info, 'Duration', 'ValueConv') + 0.5); # round
        $obj{title} = get_tag($info, 'Title');
        $obj{artist} = get_tag($info, 'Artist');
        $obj{album} = get_tag($info, 'Album');
        $obj{tracknumber} = $track;
        $obj{tracktotal} = $ntracks;
        $obj{discnumber} = $disc;
        $obj{disctotal} = $ndiscs;
        $obj{year} = $year;
        $obj{genre} = get_tag($info, 'Genre');
        $obj{duration} = $dur;
        #print "  ", join("\n  ", map { "$_=$info->{$_}" } keys %$info), "\n";
    }
    # Add to database
    foreach my $table ( qw/album artist genre/ ) {
        my ($idcol, $namecol) = ($table . 'id', $table);
        #$obj{$namecol} = '' if $table eq 'album' && !defined($obj{$namecol});
        $obj{$namecol} = undef if defined($obj{$namecol}) && $obj{$namecol} eq '';
        $obj{$idcol} = ($table eq 'album' ||
                        (defined($obj{$namecol}) && $obj{$namecol} ne '')) ?
                        lookup_row($table, map { $obj{$_->[0]} }
                                   grep { $_->[0] ne $idcol }
                                   @{$tables{$table}}) : undef;
    }
    lookup_row('track', map { $obj{$_->[0]} } @{$tables{track}});
    #print encode('utf8', ($obj{directory} ? "$obj{directory}/" : '') .
    #             $obj{filename}), "\n";
    print(($obj{directory} ? "$obj{directory}/" : '') . $obj{filename}, "\n");
    $count++;
}
$| = 1;
find({wanted => \&wanted, preprocess => \&preprocess}, $dir);
$dbh->commit;
$dbh->do('VACUUM;');
