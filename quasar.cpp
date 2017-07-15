// Search backend for Quasar, implemented in C++ for high performance.

#ifdef HAVE_FCGI
#include "fcgi_stdio.h"         // fcgi library; must be first
#endif

#include <vector>
#include <string>
#include <sstream>

#include <sqlite3.h>
#ifndef SQLITE_DETERMINISTIC    // Because oldoldstable
#warning Your version of SQLite is very old
#define SQLITE_DETERMINISTIC 0x800
#endif
#include <uriparser/Uri.h>

#include <string.h>
#include <stdlib.h>
#include <assert.h>
#include <stdio.h>

// Convert arbitrary types (e.g. integers) to a string
template <typename T> static std::string to_string(T x) {
  std::ostringstream stream;
  stream << x;
  return stream.str();
}

// SQLite function to identify subdirectories
// e.g.:
//   subdir('listened/ABBA/Greatest Hits', 'listened') = 'listened/ABBA'
//   subdir('listened/ABBA/Greatest Hits', '') = 'listened'
//   subdir('listened/ABBA/Greatest Hits', 'temp') = NULL
//   subdir('listened', 'listened') = NULL   -- [no '.' in listings]
void func_subdir(sqlite3_context *ctx, int argc, sqlite3_value**argv) {
  assert(argc == 2);
  const char *path_transient = (const char *)sqlite3_value_text(argv[0]);
  if ( !path_transient ) {
    sqlite3_result_error(ctx, "path parameter was NULL", -1);
    return;
  }
  // "the pointer returned ... can be invalidated by a subsequent call"
  // so duplicate the string onto the stack
  char path[strlen(path_transient)+1];
  strcpy(path, path_transient);

  int prefixlen = 0;
  {
    // Check prefix
    const char *prefix = (const char *)sqlite3_value_text(argv[1]);
    if ( !prefix ) {
      sqlite3_result_error(ctx, "prefix parameter was NULL", -1);
      return;
    }
    prefixlen = strlen(prefix);
    while ( prefixlen && prefix[prefixlen-1] == '/' )
      prefixlen--;
    if ( strncmp(path, prefix, prefixlen) != 0 ||
         (prefixlen > 0 && path[prefixlen] != '/') ||
         (prefixlen == 0 && path[prefixlen] == 0) ) {
      // Path doesn't begin with prefix; return NULL.
      sqlite3_result_null(ctx);
      return;
    }
    if ( path[prefixlen] == '/' )
      prefixlen++;
  }

  // Isolate next path component.
  int i = prefixlen;
  while ( path[i] && path[i] != '/' )
    i++;
  sqlite3_result_text(ctx, path, i, SQLITE_TRANSIENT);
}

class Query {
public:
  // Enumeration of database columns - NEVER trust client-provided names!
  class Column {
    const static std::string error_name;
    const static int error = -1;
  public:
    const static std::string names[];
    enum Flag { flag_none = 0, flag_raw = 1 };
    const static Flag flags[];
    const static int n;
    int id;

    Column(int column_id) : id(column_id) {
      if ( !valid() ) id = error;
    }

    Column(const std::string &column) {
      id = error;
      for ( int i = 0; i < n; i++ ) {
        if ( strcasecmp(names[i].c_str(), column.c_str()) == 0 )
          id = i;
      }
      if ( !valid() ) id = error;
    }

    bool valid() {
      return id >= 0 && id < n && id != error;
    }

    const std::string &name() {
      if ( valid() )
        return names[id];
      else
        return error_name;
    }

    bool is_raw() {
      return (flags[id] & flag_raw) != 0;
    }

    bool operator==(const int &rhs) {
      return id == rhs;
    }
    bool operator==(const Column &rhs) {
      return id == rhs.id;
    }
  };
  enum Mode { mode_search, mode_exact, mode_browse, mode_tracks };
  enum SortDirection { sort_undef = 0, sort_asc = +1, sort_desc = -1 };
  typedef std::pair<Column, SortDirection> SortEntry;
  typedef std::pair<Column, std::string> Entry;
  typedef std::vector<SortEntry> Sort;
  typedef std::vector<Column> Group;
  typedef std::vector<Entry> Entries;

  Mode mode;
  Sort sort;                    // ORDER BY ...
  Group group;                  // GROUP BY ...
  int start, count;             // LIMIT %2 OFFSET %1
  Entries queries;

  // Parse a querystr into a Query object
  int ParseQuery(const char *querystr) {
    if ( !querystr )
      return 1;

    // Parse query string into parameter list
    UriQueryListA *queryList = NULL;
    if ( uriDissectQueryMallocA(&queryList, NULL,
                                querystr[0] == '?' ? querystr+1 : querystr,
                                strchr(querystr, 0)) != URI_SUCCESS ) {
      if ( queryList )
        uriFreeQueryListA(queryList);
      return 2;
    }

    // Process newly parsed parameters
    for ( UriQueryListA *qi = queryList; qi; qi = qi->next ) {
      const char *key = qi->key, *value = qi->value;
      if ( strcasecmp(key, "mode") == 0 ) {
         if ( strcasecmp(value, "browse") == 0 )
          mode = mode_browse;
        else if ( strcasecmp(value, "tracks") == 0 )
          mode = mode_tracks;
        else if ( strcasecmp(value, "exact") == 0 )
          mode = mode_exact;
        else /* if ( strcasecmp(value, "search") == 0 ) */ // default mode
          mode = mode_search;
      }
      else if ( strcasecmp(key, "group") == 0 ) {
        std::stringstream stream;
        stream.str(value);
        std::string colname;
        while ( std::getline(stream, colname, ',') )
          group.push_back(Column(colname));
      }
      else if ( strcasecmp(key, "sort") == 0 ) {
        std::stringstream stream;
        stream.str(value);
        std::string colname;
        while ( std::getline(stream, colname, ',') )
          sort.push_back(_parseSortEntry(colname));
      }
      else if ( strcasecmp(key, "start") == 0 ) {
        start = atoi(value);
      }
      else if ( strcasecmp(key, "count") == 0 ) {
        count = atoi(value);
      }
      else {
        Column col(key);
        if ( col.valid() )
          queries.push_back(Entry(col, value));
      }
    }

    uriFreeQueryListA(queryList);

    // Normalize values
    if ( start < 0 )
      start = 0;
    if ( count < 0 )
      count = 0;

    return 0;
  }

  Query(const char *querystr = NULL) : mode(mode_search), start(0), count(100)
  {
    if ( querystr )
      ParseQuery(querystr);
  }

  ~Query() {
    //FreeQuery();
  }

  // Helper function to parse sort string (<columnname>[+-])
  static SortEntry _parseSortEntry(std::string colname) {
    SortDirection dir = sort_undef;
    // Trim leading whitespace
    {
      unsigned j = 0;
      while ( j < colname.size() && isspace(colname[j]) )
        j++;
      if ( j > 0 )
        colname.erase(0, j-1);
    }
    // Extract direction indicator and remove trailing whitespace
    {
      // On error, rfind returns npos, the largest unsigned value.
      unsigned j = colname.rfind('-'), k = colname.rfind('+');
      if ( j < k )
        dir = sort_desc;
      else {              // k <= j
        dir = sort_asc;
        j = k;
      }
      /*
        if ( j >= (unsigned)std::string::npos )
          return SortEntry(Column(-1), sort_undef); // Not found
      */
      if ( j >= 0 && j < colname.size() ) {
        while ( j > 0 && isspace(colname[j-1]) )
          j--;
        if ( j >= 0 )
          colname.erase(j); // Erase to end of line
      }
    }
    if ( colname.size() < 1 )
      return SortEntry(Column(-1), sort_undef);
    return SortEntry(Column(colname), dir);
  }

  const int build(sqlite3 *dbh, sqlite3_stmt **stmt_p) {
    static const Column column_any("any"), column_filename("filename"),
      column_directory("directory");
    // Bindings management
    typedef std::vector<std::string> bindings_t;
    bindings_t bindings;
    int browse_binding = 0;

    // For sorting a UNION, we can only use actual columns, so raw
    // columns need to be converted in advance
    std::string fake_sorts = "";
    if ( sort.size() > 0 ) {
      for ( Sort::iterator si = sort.begin(), se = sort.end();
            si != se; si++ ) {
        if ( si->first.valid() && si->first.is_raw() ) {
          const std::string &colname = si->first.name();
          fake_sorts += ", CAST(" + colname + " AS TEXT) AS "
            "_" + colname + "_text ";
        }
      }
    }

    // Parse query string
    std::string sql("SELECT directory, filename, title, artist, album, "
                    "cover, genre, tracknumber, tracktotal, year, duration " +
                    fake_sorts +
                    "FROM track "
                    "LEFT JOIN album USING (albumid) "
                    "LEFT JOIN artist USING (artistid) "
                    "LEFT JOIN genre USING (genreid) ");

    for ( Entries::iterator ai = queries.begin(), ae = queries.end();
          ai != ae; ai++ ) {
      if ( mode == mode_tracks ) {
        // Lookup specific tracks specified by filename
        if ( ai->first == column_filename ) {
          bindings.push_back(ai->second);
          sql += bindings.size() <= 1 ? "WHERE " : "OR ";
          // FIXME: use this for all filename matches?
          sql += "(directory || '/' || filename) = ?" +
            to_string(bindings.size());
        }
      }
      else if ( mode == mode_search || mode == mode_exact ||
                mode == mode_browse ) {
        // Inexact match: search for tracks with substring match.
        // FIXME: quote metacharacters.
        int inexact_match = mode == mode_search;
        bindings.push_back(inexact_match ? ("%" + ai->second + "%") :
                           ai->second);

        // Assemble SQL for this constraint
        const std::string binding_str = to_string(bindings.size());
        sql += bindings.size() <= 1 ? "WHERE " : "AND ";
        bool orNone = ai->second == "";
        if ( ai->first == column_any ) {
          sql += "(";
          for ( int ci = 1 ; 1 ; ci++ ) {
            Column col(ci);
            if ( !col.valid() ) break;
            assert(!(col == column_any)); // FIXME
            if ( ci > 1 )
              sql += " OR ";
            const std::string &colname = col.name();
            sql += (col.is_raw() ? ("CAST(" + colname + " AS TEXT)") :
                    colname) + (inexact_match ? " LIKE ?" : " = ?") +
              binding_str;
            if ( orNone )
              sql += " OR " + col.name() + " IS NULL";
          }
          sql += ")";
        }
        else {
          const std::string &colname = ai->first.name();
          if ( orNone )
            sql += "(";
          sql += (ai->first.is_raw() ? ("CAST(" + colname + " AS TEXT)") :
                  colname) + (inexact_match ? " LIKE ?" : " = ?") +
            binding_str;
          if ( orNone )
            sql += " OR " + colname + " IS NULL)";
        }

      }
      else                        // Unknown query type
        return 0x099;

      // Add current binding number to the condition
      {
        char lastchar = sql[sql.size()-1];
        if ( lastchar == '?' )
          sql += to_string(bindings.size());
        if ( lastchar != ' ' )
          sql += " ";
        // Save location of directory binding for browse mode query
        if ( mode == mode_browse && ai->first == column_directory )
          browse_binding = bindings.size();
      }
    }

    if ( mode == mode_browse ) {
      if ( !browse_binding ) {
        // No directory parameter was given; assume directory="".
        sql += bindings.size() <= 0 ? "WHERE " : "AND ";
        bindings.push_back("");
        browse_binding = bindings.size();
        sql += "directory = ?" + to_string(browse_binding);
      }

      // Also identify subdirectories of the browsed directory
      sql += " UNION ALL ";
      /* [almost working, but requires 3.7.15]
         sql += ("SELECT substr(directory, 1, length(_prefix) + "
         "              instr(_subdir, '/')-1) AS subdir, "
         "  NULL as filename, NULL as title, NULL as artist "
         "FROM ("
         "  SELECT _prefix, directory, "
         "    substr(directory, length(_prefix)+1) || '/' AS _subdir "
         "  FROM ("
         "    SELECT (CASE WHEN ?1 = '' THEN '' ELSE ?1 || '/' END) "
         "      AS _prefix, directory || '/' AS _dir, * "
         "    FROM track LEFT JOIN album USING (albumid)"
         "  ) "
         "  WHERE substr(_dir, 1, length(_prefix)) = _prefix"
         ") "
         "GROUP BY subdir ");
      */
      sql += ("SELECT subdir(directory, ?" + to_string(browse_binding) +
              ") AS subdir, NULL AS filename, NULL AS title, NULL AS artist, "
              "  NULL AS album, NULL AS cover, NULL as genre, "
              "  NULL as tracknumber, NULL as tracktotal, NULL as year, "
              "  NULL as duration " + fake_sorts +
              "FROM track LEFT JOIN album USING (albumid) "
              "WHERE subdir NOT NULL GROUP BY subdir ");
    }

    // GROUP BY parameter
    if ( group.size() > 0 ) {
      int first_one = 1;
      for ( Group::iterator gi = group.begin(), ge = group.end(); gi != ge;
            gi++ ) {
        if ( gi->valid() ) {
          sql += (first_one ? "GROUP BY " : ", ") + gi->name() + " ";
          first_one = 0;
        }
      }
    }

    // ORDER BY parameter (sort)
    if ( sort.size() > 0 ) {
      int first_one = 1;
      for ( Sort::iterator si = sort.begin(), se = sort.end();
            si != se; si++ ) {
        if ( si->first.valid() && ( si->second == sort_asc ||
                                    si->second == sort_desc ) ) {
          const std::string &colname = si->first.name();
          sql += (first_one ? "ORDER BY " : ", ") +
            colname + " "//(si->first.is_raw() ? ("_" + colname + "_text") : colname) + " "
            "COLLATE NOCASE " + (si->second == sort_asc ? "ASC " : "DESC ");
          first_one = 0;
        }
      }
    }

    // LIMIT and OFFSET parameters
    sql += "LIMIT " + to_string(count) + " OFFSET " + to_string(start) + " ";
    //fprintf(stderr, "%s\n", sql.c_str());

    // Compile statement
    sqlite3_stmt *stmt;
    if ( sqlite3_prepare(dbh, sql.c_str(), -1, &stmt, NULL) != SQLITE_OK ) {
      sqlite3_finalize(stmt);
      return 0x700;
    }

    // Bind parameters
    sqlite3_reset(stmt);          // FIXME: error code
    int i = 0;
    for ( bindings_t::iterator bi = bindings.begin(), be = bindings.end();
          bi != be; bi++ ) {
      if ( sqlite3_bind_text(stmt, i+1, bi->c_str(), -1, SQLITE_TRANSIENT)
           != SQLITE_OK ) {
        sqlite3_finalize(stmt);
        return (i+1) | 0x700;
      }
      i++;
    }

    *stmt_p = stmt;
    return 0;
  }
};
const std::string Query::Column::error_name = "";
const std::string Query::Column::names[] = {
  "any", "directory", "filename", "title", "album", "artist", "genre",
  "tracknumber"
};
const Query::Column::Flag Query::Column::flags[] = {
  /* any */flag_none, /* directory */flag_raw, /* filename */flag_raw,
  /* title */flag_none, /* album */flag_none, /* artist */flag_none,
  /* genre */flag_none, /* tracknumber */flag_none
};
const int Query::Column::n = sizeof(Query::Column::names) /
            sizeof(Query::Column::names[0]);

// Rudimentary JSON output support
enum JsonType { json_t_null = 0, json_t_num, json_t_str, json_t_urlstr };

static int json_p_null() {
  return fputs("null", stdout) == EOF ? 0x01 : 0;
}

static int json_p_num(int val) {
  return printf("%d", val) <= 0 ? 0x02 : 0;
}

static int json_p_str(const unsigned char *str, JsonType encoding) {
  if ( !str )
    return json_p_null();

  int i;
  if ( fputc('"', stdout) == EOF ) return 0x05;
  for ( i = 0; str[i]; i++ ) {
    unsigned char c = str[i];
    //unsigned char s[3];
    if ( encoding == json_t_urlstr &&
         !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') || c == '-' || c == '.' || c == '_' ||
           c == '/' /* NORMALLY EXCLUDED, but not in this case */ ) ) {
      if ( printf("%%%02X", c) <= 0 ) return 0x06;
    }
    else if ( c < 0x20 || c == '"' || c == '\\' ) {
      if ( printf("\\u%04x", c) <= 0 ) return 0x07;
    }
    else if ( fputc(c, stdout) == EOF ) return 0x08;
  }
  if ( fputc('"', stdout) == EOF ) return 0x09;
  return 0;
}

static int json_p_kv(const char *key, const void *value,
                     JsonType type, const char *indent, int comma) {
  int rc;
  if ( indent )
    fputs(indent, stdout);
  rc = json_p_str((const unsigned char *)key, json_t_str);
  if ( rc != 0 ) return 10 + rc;
  if ( fputs(": ", stdout) == EOF ) return 2;
  if ( type == json_t_null || !value )
    rc = json_p_null();
  else if ( type == json_t_num )
    rc = json_p_num(*(const int *)value);
  else if ( type == json_t_str || type == json_t_urlstr )
    rc = json_p_str((const unsigned char *)value, type);
  else
    assert(0);
  if ( rc != 0 ) return 20 + rc;
  if ( comma >= 0 && fputs(comma ? ",\n" : "\n", stdout) == EOF ) return 3;
  return 0;
}

// Run a query statement on the database and output the results as JSON
int query_run(Query &query, sqlite3_stmt *stmt) {
  int i = 0, rc;
  fputs("  \"results\": [\n", stdout);

  // Read results from the database
  while ( (rc = sqlite3_step(stmt)) == SQLITE_ROW ) {
    if ( i > 0 ) fputs(",\n", stdout);
    fputs("    {\n", stdout);

    /*
    count = sqlite3_column_int(stmt, 0);
    printf("=== %d\n", count);
    */

    // Output each column as key-value data
    int c, cmax = sqlite3_data_count(stmt);
    for ( c = 0; c < cmax; c++ ) { // skip count column
      int col_type = sqlite3_column_type(stmt, c);
      const char *col_name = sqlite3_column_name(stmt, c);

      // Check column name
      if ( col_name && col_name[0] == '_')
        continue;
      if ( strcmp(col_name, "subdir") == 0 ) {
        cmax = c+1;
        col_name = "directory";
        assert(c == 0 && query.mode != Query::mode_browse);
      }
      else if ( strchr(col_name, ' ') || strchr(col_name, '(') )
        return 0x300 | c;
      const char *indent = c > 0 ? (",\n      ") : "      ";

      // Output column data
      if ( col_type == SQLITE_NULL ) {
        if ( strcmp(col_name, "filename") == 0 )
          cmax = c+1;
        else
          rc = json_p_kv(col_name, NULL, json_t_null, indent, -1);
      }

      else if ( col_type == SQLITE_INTEGER ) {
        int col_value = sqlite3_column_int(stmt, c);
        rc = json_p_kv(col_name, &col_value, json_t_num, indent, -1);
      }

      else if ( col_type == SQLITE_TEXT || col_type == SQLITE_BLOB ) {
        const unsigned char *col_value;
        col_value = sqlite3_column_text(stmt, c);
        if ( !col_value ) return 0x200 | c;
        bool do_urlencode = (strcmp(col_name, "filename") == 0 ||
                             strcmp(col_name, "directory") == 0 ||
                             strcmp(col_name, "cover") == 0 );
        rc = json_p_kv(col_name, col_value,
                       do_urlencode ? json_t_urlstr : json_t_str,
                       indent, -1);
      }

      else
        return 0x300 | c;
      if ( rc != 0 ) return 0x400 | rc;
    }

    fputs("\n    }", stdout);
    i++;
  }
  fputs("\n  ],\n", stdout);

  // Additional parameters
  json_p_kv("start", &(query.start), json_t_num, "  ", 1);
  json_p_kv("count", &i, json_t_num, "  ", 1);
  //json_p_kv("total", &count, json_t_num, "  ", 1);

  if ( rc != SQLITE_DONE )
    return 0x101;
  return 0;
}

static inline int do_accept(void) {
#ifdef _FCGI_STDIO
  return FCGI_Accept() >= 0;
#else
  static int c = 0;
  return !(c++);
#endif
}

int main(int argc, char *argv[]) {
  // Open database
  sqlite3 *dbh = NULL;
  const char *dbfile = getenv("QUASAR_DBFILE");
  if ( !dbfile ) dbfile = "quasar.db";
  int rc = sqlite3_open_v2(dbfile, &dbh, SQLITE_OPEN_READONLY, NULL);
  if ( rc != SQLITE_OK ) {
    fprintf(stderr, "sqlite open: %s: %s\n", dbfile, sqlite3_errmsg(dbh));
    sqlite3_close(dbh);
    return 1;
  }

  // Install custom function
  rc = sqlite3_create_function(dbh, "subdir", 2,
                               SQLITE_UTF8|SQLITE_DETERMINISTIC,
                               NULL, &func_subdir, NULL, NULL);
  if ( rc != SQLITE_OK ) {
    fprintf(stderr, "sqlite create function: %s\n", sqlite3_errmsg(dbh));
    sqlite3_close(dbh);
    return 1;
  }

  // Response loop.
  while ( do_accept() ) {
    Query query;
    if ( argc > 1 )
      query.ParseQuery(argv[1]);
    else if ( getenv("HTTP_CONTENT_LENGTH") )
      abort();                  // Read POST data
    else
      query.ParseQuery(getenv("QUERY_STRING"));
    /* {
      fprintf(stderr, "Error: no QUERY_STRING\n");
      continue;
    }
    */

    sqlite3_stmt *stmt = NULL;
    rc = query.build(dbh, &stmt);
    if ( rc != 0 ) {
      if ( rc < 0x100 )
        fprintf(stderr, "query.build: Error 0x%03x while parsing request\n",
                rc);
      else
        fprintf(stderr, "query.build: Error 0x%03x (SQL error: %s)\n",
                rc, sqlite3_errmsg(dbh));
      continue;
    }

    // Perform search
    printf("Content-type: application/json; charset=utf-8\r\n"
           "\r\n");
    fputs("{\n", stdout);
    rc = query_run(query, stmt);
    json_p_kv("error", &rc, json_t_num, "  ", 0);
    if ( rc != 0 ) {
      fprintf(stderr, "query_run: Error 0x%03x (SQL error: %s)\n",
              rc, sqlite3_errmsg(dbh));
      // Fall through to cleanup below
    }
    fputs("}\n", stdout);
    sqlite3_finalize(stmt);
  }

  // Final cleanup
  rc = sqlite3_close(dbh);
  if ( rc != SQLITE_OK ) {
    fprintf(stderr, "sqlite close: %s\n", sqlite3_errmsg(dbh));
    return 1;
  }
  return 0;
}
